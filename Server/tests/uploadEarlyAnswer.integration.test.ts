import fs from "fs";
import net from "net";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UNREAD_BODY_GRACE_MS } from "../middlewares/unreadBody";
import { UPLOAD_INFLIGHT_PER_MEMBER_MAX, UPLOAD_REQUEST_TIMEOUT_MS, uploadInFlightLimit } from "../middlewares/uploadInFlight";
import { useTestServer } from "./socketHarness";

// EXP-449: an admitted upload answered before its body arrived (here the per-member rate limit, 429) keeps its
// in-flight slot and its upload timeout while the rest of its body drains: the body is cut at UPLOAD_REQUEST_TIMEOUT_MS
// (not after HTTP_REQUEST_TIMEOUT_MS, 60 s), and a member can't keep more than UPLOAD_INFLIGHT_PER_MEMBER_MAX of them
// draining at once.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-early-answer-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  // One upload per member: every later one is answered 429 after admission, before its body is read
  process.env.UPLOAD_PLAYER_RATE_MAX = "1";
  process.env.UPLOAD_REQUEST_TIMEOUT_MS = "1500";
  process.env.UPLOAD_INFLIGHT_PER_MEMBER_MAX = "2";
  return dir;
});

const BOUNDARY = "exposeme-early-answer-boundary";
/** A slow sender: one 1 KB chunk every TRICKLE_INTERVAL_MS, for as long as the server reads it. */
const TRICKLE_CHUNK = Buffer.concat([Buffer.from(`${(1024).toString(16)}\r\n`), Buffer.alloc(1024, "y"), Buffer.from("\r\n")]);
const TRICKLE_INTERVAL_MS = 50;
/** Scheduling slack on top of the server's own limits. */
const SLACK_MS = 1_000;

const harness = useTestServer();
let auth: Record<string, string> = {};
const open: net.Socket[] = [];

interface Trickle {
  /** Everything the server sent back. */
  response: () => string;
  /** Resolves with the ms from the request to the server ending its side of the connection (FIN). */
  ended: Promise<number>;
  /** Resolves with the ms from the request to the connection being closed for good. */
  closed: Promise<number>;
}

/**
 * A chunked upload whose body trickles in and never ends. The client ignores the server's FIN and keeps sending (an
 * abusive client), so only the server can close the connection.
 */
function trickleUpload(): Trickle {
  const t0 = Date.now();
  let response = "";
  const socket = net.connect({ port: harness.port, host: "127.0.0.1", allowHalfOpen: true });
  open.push(socket);
  socket.setEncoding("latin1");
  socket.on("data", (d: string) => (response += d));
  socket.on("error", () => {}); // reset while still writing
  const ended = new Promise<number>((resolve) => socket.once("end", () => resolve(Date.now() - t0)));
  const closed = new Promise<number>((resolve) => socket.once("close", () => resolve(Date.now() - t0)));
  const head = Object.entries({ ...auth, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  socket.write(`POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n${head}\r\n`);
  const timer = setInterval(() => {
    if (socket.destroyed) clearInterval(timer);
    else socket.write(TRICKLE_CHUNK);
  }, TRICKLE_INTERVAL_MS);
  socket.once("close", () => clearInterval(timer));
  return { response: () => response, ended, closed };
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const inFlight = () => uploadInFlightLimit.inFlight().total;
const statusLine = (response: string) => response.match(/^HTTP\/1\.1 \d{3}/)?.[0];
const jsonBody = (response: string) => JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));

beforeAll(async () => {
  const { room, rejoinToken } = await harness.joinAs(await harness.newClient(), null, "Alice");
  auth = { Authorization: `Bearer ${rejoinToken!}`, "X-Game-Code": room!.gameCode };
  // Uses up Alice's upload rate limit
  const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  const res = await fetch(`${harness.url}/upload`, { method: "POST", body: form, headers: auth });
  expect(res.status).toBe(200);
});

afterEach(async () => {
  open.splice(0).forEach((s) => s.destroy());
  await waitFor(() => inFlight() === 0);
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("an upload answered after admission, before its body arrived", () => {
  it("keeps its in-flight slot while its body trickles in, and is cut at UPLOAD_REQUEST_TIMEOUT_MS", async () => {
    expect(UPLOAD_REQUEST_TIMEOUT_MS).toBe(1_500);
    const upload = trickleUpload();
    await waitFor(() => upload.response().length > 0);
    expect(statusLine(upload.response())).toBe("HTTP/1.1 429");
    expect(jsonBody(upload.response())).toEqual({ error: "Too many uploads" });

    // Answered, but its body is still arriving: the slot is still taken
    await new Promise((r) => setTimeout(r, UPLOAD_REQUEST_TIMEOUT_MS / 2));
    expect(inFlight()).toBe(1);

    // The server ends its side at the upload timeout and closes the connection a grace period later
    expect(await upload.ended).toBeGreaterThanOrEqual(UPLOAD_REQUEST_TIMEOUT_MS - 100);
    expect(await upload.ended).toBeLessThan(UPLOAD_REQUEST_TIMEOUT_MS + SLACK_MS);
    expect(await upload.closed).toBeLessThan(UPLOAD_REQUEST_TIMEOUT_MS + UNREAD_BODY_GRACE_MS + SLACK_MS);
    await waitFor(() => inFlight() === 0);
  });

  it(`a member can't keep more than UPLOAD_INFLIGHT_PER_MEMBER_MAX of them draining at once`, async () => {
    const draining = Array.from({ length: UPLOAD_INFLIGHT_PER_MEMBER_MAX }, trickleUpload);
    await waitFor(() => draining.every((u) => u.response().length > 0));
    for (const u of draining) expect(statusLine(u.response())).toBe("HTTP/1.1 429");
    expect(inFlight()).toBe(UPLOAD_INFLIGHT_PER_MEMBER_MAX);

    const extra = trickleUpload();
    await waitFor(() => extra.response().length > 0);
    expect(statusLine(extra.response())).toBe("HTTP/1.1 429");
    expect(jsonBody(extra.response())).toEqual({ error: "Too many uploads in progress", scope: "member" });
    expect(inFlight()).toBe(UPLOAD_INFLIGHT_PER_MEMBER_MAX);
  });
});
