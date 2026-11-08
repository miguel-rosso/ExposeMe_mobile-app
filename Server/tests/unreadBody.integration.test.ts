import fs from "fs";
import net from "net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pendingUnreadBodyGraces, UNREAD_BODY_GRACE_MS } from "../middlewares/unreadBody";
import { useTestServer } from "./socketHarness";

// EXP-448: once a response is out, a request body still arriving is not read (and discarded) until the request
// timeout: it gets UNREAD_BODY_GRACE_MS to finish, then the connection is closed, whoever answered (Express route,
// middleware or socket.io's long-polling endpoint) and whether or not the request had credentials. The client still
// receives the response, and a body that finishes in time keeps its keep-alive connection. An admitted upload answered
// early is left to its own byte cap (EXP-442), so a member on a slow network still reads the answer.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-unread-body-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  // One upload per member, so a member's second upload is answered 429 after admission, before its body is read
  process.env.UPLOAD_PLAYER_RATE_MAX = "1";
  return dir;
});

/** A rejected request's connection must be closed within this, not after HTTP_REQUEST_TIMEOUT_MS (60 s). */
const CLOSE_WITHIN_MS = UNREAD_BODY_GRACE_MS + 1_000;
const BOUNDARY = "exposeme-unread-body-boundary";
const CHUNK_BYTES = 64 * 1024;
/** One chunked-encoding frame carrying CHUNK_BYTES of filler. */
const CHUNK_FRAME = Buffer.concat([
  Buffer.from(`${CHUNK_BYTES.toString(16)}\r\n`),
  Buffer.alloc(CHUNK_BYTES, "x"),
  Buffer.from("\r\n"),
]);
const LAST_CHUNK = "0\r\n\r\n";
/** A slow network: one 1 KB chunk every SLOW_CHUNK_INTERVAL_MS. */
const SLOW_CHUNK = Buffer.concat([Buffer.from(`${(1024).toString(16)}\r\n`), Buffer.alloc(1024, "y"), Buffer.from("\r\n")]);
const SLOW_CHUNK_INTERVAL_MS = 50;

const harness = useTestServer();
let auth: Record<string, string> = {};
let jpeg: Buffer;

const requestHead = (method: string, path: string, headers: Record<string, string>) =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
  Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
  "\r\n";

const chunked = { "Transfer-Encoding": "chunked" };
const multipart = { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` };
const statusLines = (response: string) => response.match(/HTTP\/1\.1 \d{3}/g) ?? [];

interface Outcome {
  response: string;
  closed: boolean;
  /** Time from the first byte of the response to the connection closing. */
  closedAfterMs: number;
}

/**
 * Sends `head` (a chunked request) followed by an endless chunked body, written as fast as the server reads it, and
 * resolves with what came back once the server closes the connection, or after `waitMs`.
 */
function sendEndlessBody(head: string, waitMs = CLOSE_WITHIN_MS + 1_000): Promise<Outcome> {
  return new Promise((resolve) => {
    let response = "";
    let closed = false;
    let answeredAt = 0;
    const socket = net.connect(harness.port, "127.0.0.1");
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ response, closed, closedAfterMs: closed && answeredAt ? Date.now() - answeredAt : Infinity });
    };
    const timer = setTimeout(finish, waitMs);
    socket.setEncoding("latin1");
    socket.on("data", (d: string) => {
      if (!answeredAt) answeredAt = Date.now();
      response += d;
    });
    socket.on("error", () => {}); // reset while still writing
    socket.on("close", () => {
      closed = true;
      finish();
    });
    socket.write(head);
    const writeMore = () => {
      while (!socket.destroyed) {
        if (!socket.write(CHUNK_FRAME)) return void socket.once("drain", writeMore);
      }
    };
    writeMore();
  });
}

/**
 * Writes `steps` on one connection, each after its delay (ms since the previous one); resolves with everything
 * received `waitMs` after the last one, and whether the server closed the connection.
 */
function sendOnOneConnection(steps: [number, string | Buffer][], waitMs = 500): Promise<{ response: string; closed: boolean }> {
  return new Promise((resolve) => {
    let response = "";
    let closed = false;
    const socket = net.connect(harness.port, "127.0.0.1");
    socket.setEncoding("latin1");
    socket.on("data", (d: string) => (response += d));
    socket.on("close", () => (closed = true));
    socket.on("error", () => {});
    const writeFrom = (i: number) => {
      if (i === steps.length) return void setTimeout(() => {
        socket.destroy();
        resolve({ response, closed });
      }, waitMs);
      const [delay, data] = steps[i];
      setTimeout(() => {
        if (!socket.destroyed) socket.write(data);
        writeFrom(i + 1);
      }, delay);
    };
    writeFrom(0);
  });
}

const multipartUpload = (photo: Buffer) =>
  Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    photo,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

beforeAll(async () => {
  const { room, rejoinToken } = await harness.joinAs(await harness.newClient(), null, "Alice");
  auth = { Authorization: `Bearer ${rejoinToken!}`, "X-Game-Code": room!.gameCode };
  jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#33a" } }).jpeg().toBuffer();
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("a response sent before the request body has arrived closes the connection", () => {
  it.each([
    ["POST /upload without credentials (401)", () => requestHead("POST", "/upload", { ...chunked, ...multipart }), 401],
    [
      "POST /upload with a wrong token (403)",
      () => requestHead("POST", "/upload", { ...chunked, ...multipart, ...auth, Authorization: "Bearer wrong-token" }),
      403,
    ],
    ["POST to an unknown route (404)", () => requestHead("POST", "/no-such-route", chunked), 404],
    ["POST /temp/<name> (404)", () => requestHead("POST", "/temp/whatever.jpg", chunked), 404],
    // No body parser reads a JSON body to its end before anything answers
    ["a JSON body (404)", () => requestHead("POST", "/no-such-route", { ...chunked, "Content-Type": "application/json" }), 404],
    ["a socket.io long-polling POST without a session (400)", () => requestHead("POST", "/socket.io/?EIO=4&transport=polling", chunked), 400],
  ])("%s", async (_what, head, status) => {
    const { response, closed, closedAfterMs } = await sendEndlessBody(head());
    expect(response).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
    expect(closed).toBe(true);
    expect(closedAfterMs).toBeLessThan(CLOSE_WITHIN_MS);
  });

  it("an admitted upload answered before its body is read (member rate limit, 429) is cut by the upload byte cap", async () => {
    await useUpUploadLimit();
    const { response, closed } = await sendEndlessBody(requestHead("POST", "/upload", { ...chunked, ...multipart, ...auth }));
    expect(response).toMatch(/^HTTP\/1\.1 429 /);
    expect(closed).toBe(true);
  });

  it("leaves no grace period pending once those connections are closed", () => {
    expect(pendingUnreadBodyGraces()).toBe(0);
  });
});

describe("a request body that is complete keeps its keep-alive connection", () => {
  const health = requestHead("GET", "/health", {});

  it("answers the next request after one rejected with its small body in the same packet", async () => {
    const rejected = requestHead("POST", "/upload", { ...multipart, "Content-Length": "5" }) + "hello";
    const { response, closed } = await sendOnOneConnection([[0, rejected + health]]);
    expect(statusLines(response)).toEqual(["HTTP/1.1 401", "HTTP/1.1 200"]);
    expect(closed).toBe(false);
  });

  it("answers the next request after one rejected whose body ended within the grace period", async () => {
    const { response, closed } = await sendOnOneConnection([
      [0, requestHead("POST", "/no-such-route", chunked)],
      [0, CHUNK_FRAME],
      [UNREAD_BODY_GRACE_MS / 4, LAST_CHUNK + health],
    ]);
    expect(statusLines(response)).toEqual(["HTTP/1.1 404", "HTTP/1.1 200"]);
    expect(closed).toBe(false);
    // Still within the grace period: its timer was cancelled when the body ended, not left pending until it fires
    expect(pendingUnreadBodyGraces()).toBe(0);
  });

  it("lets a member on a slow network finish an upload answered 429 after admission, past the grace period", async () => {
    await useUpUploadLimit();
    const slowChunks = Math.ceil((UNREAD_BODY_GRACE_MS * 1.5) / SLOW_CHUNK_INTERVAL_MS);
    const { response, closed } = await sendOnOneConnection([
      [0, requestHead("POST", "/upload", { ...chunked, ...multipart, ...auth })],
      ...Array.from({ length: slowChunks }, (): [number, Buffer] => [SLOW_CHUNK_INTERVAL_MS, SLOW_CHUNK]),
      [0, LAST_CHUNK + health],
    ]);
    expect(statusLines(response)).toEqual(["HTTP/1.1 429", "HTTP/1.1 200"]);
    expect(closed).toBe(false);
  });
});

/** Alice's first upload (once per file): uses up her upload rate limit (UPLOAD_PLAYER_RATE_MAX=1), so the next get 429. */
let uploadLimitUsedUp = false;
async function useUpUploadLimit() {
  if (uploadLimitUsedUp) return;
  uploadLimitUsedUp = true;
  const body = multipartUpload(jpeg);
  const { response } = await sendOnOneConnection(
    [[0, requestHead("POST", "/upload", { ...multipart, ...auth, "Content-Length": String(body.length) })], [0, body]],
    1_000,
  );
  expect(statusLines(response)).toEqual(["HTTP/1.1 200"]);
}
