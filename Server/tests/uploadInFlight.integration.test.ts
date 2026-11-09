import fs from "fs";
import http from "http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS, server } from "../app";
import { MAX_FILE_SIZE } from "../middlewares/upload";
import { uploadInFlightLimit } from "../middlewares/uploadInFlight";
import { useTestServer } from "./socketHarness";

// EXP-165: POST /upload buffers each body in memory, so the number of uploads being received at once is capped per
// member, per room, per IP and server-wide, *after* the credentials are checked (only members take slots) and *before*
// the body is read; a declared oversize body is refused up front; an admitted upload must arrive within its own
// timeout. EXP-169: /health exposes nothing but its status.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-inflight-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_INFLIGHT_MAX = "3";
  process.env.UPLOAD_INFLIGHT_PER_IP_MAX = "2";
  process.env.UPLOAD_INFLIGHT_PER_ROOM_MAX = "2";
  process.env.UPLOAD_INFLIGHT_PER_MEMBER_MAX = "1";
  process.env.UPLOAD_REQUEST_TIMEOUT_MS = "1500";
  // req.ip from X-Forwarded-For, so one test process can act as several clients
  process.env.TRUST_PROXY = "1";
  for (const name of ["HTTP_REQUEST_TIMEOUT_MS", "HTTP_HEADERS_TIMEOUT_MS"]) delete process.env[name];
  process.env.UPLOAD_PLAYER_RATE_MAX = "100000";
  process.env.UPLOAD_ROOM_RATE_MAX = "100000";
  return dir;
});

// Lets a test make image processing slower than UPLOAD_REQUEST_TIMEOUT_MS
const sanitizeDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock("../controllers/sanitizeImage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../controllers/sanitizeImage")>();
  return {
    ...mod,
    sanitizeImage: async (input: Buffer) => {
      if (sanitizeDelay.ms) await new Promise((r) => setTimeout(r, sanitizeDelay.ms));
      return mod.sanitizeImage(input);
    },
  };
});

const BOUNDARY = "----exposemeinflight";
type Auth = Record<string, string>;
const harness = useTestServer();
// r1: alice, bob, carol (one room); dave, erin, frank: each alone in their own room
const m: Record<string, Auth> = {};
const open: http.ClientRequest[] = [];

async function join(gameCode: string | null, username: string): Promise<{ gameCode: string; auth: Auth }> {
  const { room, rejoinToken } = await harness.joinAs(await harness.newClient(), gameCode, username);
  return { gameCode: room!.gameCode, auth: { Authorization: `Bearer ${rejoinToken!}`, "X-Game-Code": room!.gameCode } };
}

/**
 * An upload whose body is still arriving: headers plus the start of the file part, then nothing more. Resolves with
 * the status if the server answers within `waitMs`, or null if it is still receiving it.
 */
function slowUpload(
  auth: Auth,
  ip: string,
  { declared = 1_000_000, waitMs = 300 } = {},
): Promise<{ status: number | null; body: string; ms: number; req: http.ClientRequest }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: harness.port,
      method: "POST",
      path: "/upload",
      headers: {
        ...auth,
        "X-Forwarded-For": ip,
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        "Content-Length": String(declared),
      },
    });
    open.push(req);
    req.on("error", () => {}); // the server may close the socket after answering early
    const timer = setTimeout(() => resolve({ status: null, body: "", ms: Date.now() - t0, req }), waitMs);
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body, ms: Date.now() - t0, req }); });
    });
    req.write(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    req.write(Buffer.alloc(1024));
  });
}

/**
 * An upload that sends its whole declared body as fast as the server takes it, still sending when it is answered.
 * Resolves with the response, or a null status if the connection was closed before one could be read (EXP-455).
 */
function fastUpload(
  auth: Auth,
  ip: string,
  bytes: number,
): Promise<{ status: number | null; retryAfter?: string; connection?: string; body: string }> {
  const chunk = Buffer.alloc(64 * 1024);
  return new Promise((resolve) => {
    const result: { status: number | null; retryAfter?: string; connection?: string; body: string } = { status: null, body: "" };
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(result); } };
    const req = http.request({
      host: "127.0.0.1",
      port: harness.port,
      method: "POST",
      path: "/upload",
      agent: false,
      headers: {
        ...auth,
        "X-Forwarded-For": ip,
        "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`,
        "Content-Length": String(bytes),
      },
    });
    req.on("response", (res) => {
      result.status = res.statusCode ?? 0;
      result.retryAfter = res.headers["retry-after"] as string | undefined;
      result.connection = res.headers.connection;
      res.setEncoding("utf8");
      res.on("data", (c) => (result.body += c));
      res.on("end", settle);
      res.on("error", settle);
    });
    req.on("error", () => setTimeout(settle, 200)); // let a response that is already arriving be read
    req.on("close", () => setTimeout(settle, 200));
    let left = bytes;
    const writeMore = () => {
      while (left > 0 && !req.destroyed) {
        const piece = chunk.subarray(0, Math.min(left, chunk.length));
        left -= piece.length;
        if (!req.write(piece)) return void req.once("drain", writeMore);
      }
      if (left === 0) req.end();
    };
    writeMore();
  });
}

const held = async (...reqs: Array<Promise<{ status: number | null }>>) => {
  const res = await Promise.all(reqs);
  expect(res.map((r) => r.status)).toEqual(reqs.map(() => null));
};

async function waitFor(cond: () => boolean, timeoutMs = 3_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const inFlight = () => uploadInFlightLimit.inFlight().total;

beforeAll(async () => {
  const alice = await join(null, "Alice");
  m.alice = alice.auth;
  m.bob = (await join(alice.gameCode, "Bob")).auth;
  m.carol = (await join(alice.gameCode, "Carol")).auth;
  for (const name of ["dave", "erin", "frank"]) m[name] = (await join(null, name)).auth;
});

afterEach(async () => {
  open.splice(0).forEach((r) => r.destroy());
  await waitFor(() => inFlight() === 0);
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

// ── Concurrency caps ──
describe("in-flight upload caps", () => {
  it("unauthenticated requests are refused before taking any slot", async () => {
    const res = await slowUpload({}, "10.0.9.1", { waitMs: 2_000 });
    expect(res.status).toBe(401);
    await held(slowUpload(m.dave, "10.0.9.2"));
    expect(inFlight()).toBe(1);
  });

  it("per member: a second concurrent upload from the same member gets 429 (scope member)", async () => {
    await held(slowUpload(m.alice, "10.0.0.1"));
    const extra = await slowUpload(m.alice, "10.0.0.2", { waitMs: 2_000 });
    expect(extra.status).toBe(429);
    expect(JSON.parse(extra.body)).toEqual({ error: "Too many uploads in progress", scope: "member" });
    await held(slowUpload(m.bob, "10.0.0.3")); // another member of the room still gets in
  });

  it("per room: a third concurrent upload in one room gets 429 (scope room), other rooms still get in", async () => {
    await held(slowUpload(m.alice, "10.0.1.1"), slowUpload(m.bob, "10.0.1.2"));
    const extra = await slowUpload(m.carol, "10.0.1.3", { waitMs: 2_000 });
    expect(extra.status).toBe(429);
    expect(JSON.parse(extra.body).scope).toBe("room");
    await held(slowUpload(m.dave, "10.0.1.4"));
  });

  it("per IP: a third concurrent upload from one IP gets 429 (scope ip), across rooms", async () => {
    await held(slowUpload(m.alice, "10.0.2.1"), slowUpload(m.dave, "10.0.2.1"));
    const extra = await slowUpload(m.erin, "10.0.2.1", { waitMs: 2_000 });
    expect(extra.status).toBe(429);
    expect(JSON.parse(extra.body).scope).toBe("ip");
    await held(slowUpload(m.erin, "10.0.2.2"));
  });

  it("server-wide: the upload over the global cap gets 503 at once while the others are still being received", async () => {
    await held(slowUpload(m.alice, "10.0.3.1"), slowUpload(m.dave, "10.0.3.2"), slowUpload(m.erin, "10.0.3.3"));
    expect(inFlight()).toBe(3);
    const extra = await slowUpload(m.frank, "10.0.3.4", { waitMs: 2_000 });
    expect(extra.status).toBe(503);
    expect(extra.ms).toBeLessThan(1_000);
    expect(JSON.parse(extra.body)).toEqual({ error: "Server busy", scope: "server" });
    expect(inFlight()).toBe(3);
  });

  it("a refused client still sending its photo reads the 429 and its Retry-After, not a reset (EXP-455)", async () => {
    await held(slowUpload(m.alice, "10.0.7.1"));
    const extra = await fastUpload(m.alice, "10.0.7.2", 4 * 1024 * 1024);
    expect(extra.status).toBe(429);
    expect(extra.retryAfter).toBe("2");
    expect(extra.connection).toBe("close");
    expect(JSON.parse(extra.body)).toEqual({ error: "Too many uploads in progress", scope: "member" });
    expect(inFlight()).toBe(1);
  });

  it("frees the slot when the client aborts mid-upload, and after a completed upload", async () => {
    const first = await slowUpload(m.alice, "10.0.4.1");
    expect(first.status).toBeNull();
    first.req.destroy();
    await waitFor(() => inFlight() === 0);
    await held(slowUpload(m.alice, "10.0.4.1"));
    open.splice(0).forEach((r) => r.destroy());
    await waitFor(() => inFlight() === 0);

    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#33a" } }).jpeg().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
    const res = await fetch(`${harness.url}/upload`, { method: "POST", body: form, headers: { ...m.alice, "X-Forwarded-For": "10.0.4.9" } });
    expect(res.status).toBe(200);
    expect(uploadInFlightLimit.inFlight()).toEqual({ total: 0, ips: 0, rooms: 0, members: 0 });
  });

  it("an upload not fully received within UPLOAD_REQUEST_TIMEOUT_MS gets 408 and frees its slot", async () => {
    const res = await slowUpload(m.dave, "10.0.5.1", { waitMs: 4_000 });
    expect(res.status).toBe(408);
    expect(res.ms).toBeGreaterThanOrEqual(1_400);
    expect(JSON.parse(res.body)).toEqual({ error: "Upload timed out" });
    await waitFor(() => inFlight() === 0);
  });

  it("only times the body's reception: slow processing of a complete body still answers 200 and stores the photo", async () => {
    const before = new Set(fs.readdirSync(UPLOAD_DIR));
    sanitizeDelay.ms = 2_500; // > UPLOAD_REQUEST_TIMEOUT_MS (1.5 s)
    try {
      const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#a33" } }).jpeg().toBuffer();
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
      const t0 = Date.now();
      const res = await fetch(`${harness.url}/upload`, { method: "POST", body: form, headers: { ...m.erin, "X-Forwarded-For": "10.0.5.9" } });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2_400);
      expect(res.status).toBe(200);
      const { url: p } = (await res.json()) as { url: string };
      const added = fs.readdirSync(UPLOAD_DIR).filter((f) => !before.has(f));
      expect(added).toEqual([p.replace("/temp/", "")]); // exactly the returned photo, no orphan
      const got = await fetch(`${harness.url}${p}`, { headers: m.erin });
      expect(got.status).toBe(200);
    } finally {
      sanitizeDelay.ms = 0;
    }
    await waitFor(() => inFlight() === 0);
  });
});

// ── Size limit ──
describe("upload size", () => {
  it("is 5 MB, enough for the app's ≤1600 px JPEGs", () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  it("a client still sending a declared body over the limit reads the 413, not a reset (EXP-455)", async () => {
    const res = await fastUpload(m.alice, "10.0.6.9", MAX_FILE_SIZE * 2);
    expect(res.status).toBe(413);
    expect(res.connection).toBe("close");
    expect(JSON.parse(res.body)).toEqual({ error: "File too large" });
    expect(inFlight()).toBe(0);
  });

  it("refuses a declared body over the limit with 413 JSON before reading it, without taking a slot", async () => {
    await held(slowUpload(m.dave, "10.0.6.1"), slowUpload(m.erin, "10.0.6.2"), slowUpload(m.frank, "10.0.6.3"));
    const res = await slowUpload(m.alice, "10.0.6.4", { declared: MAX_FILE_SIZE * 2, waitMs: 2_000 });
    expect(res.status).toBe(413); // not 503: checked before the caps
    expect(JSON.parse(res.body)).toEqual({ error: "File too large" });
    expect(inFlight()).toBe(3);
  });

  it("refuses an actual file over the limit with 413 JSON", async () => {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(MAX_FILE_SIZE + 1)], { type: "image/jpeg" }), "big.jpg");
    const res = await fetch(`${harness.url}/upload`, { method: "POST", body: form, headers: m.alice });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

// ── HTTP timeouts ──
describe("HTTP server timeouts", () => {
  it("bound how long a request (body included) and its headers may take to arrive", () => {
    expect(HTTP_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBe(20_000);
    expect(server.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
  });
});

// ── /health ──
describe("GET /health", () => {
  it("answers 200 with only its status (no uptime, memory or timestamp)", async () => {
    const res = await fetch(`${harness.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
