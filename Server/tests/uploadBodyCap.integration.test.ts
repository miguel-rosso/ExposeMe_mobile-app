import fs from "fs";
import http from "http";
import net from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_WIRE_BYTES, uploadInFlightLimit } from "../middlewares/uploadInFlight";
import { useTestServer } from "./socketHarness";

// EXP-442: a chunked POST /upload (no Content-Length) can't carry more than MAX_UPLOAD_BODY_BYTES in total, whatever
// multer ignores (a preamble before the first boundary, an epilogue after the last one), nor take more than
// MAX_UPLOAD_WIRE_BYTES off the wire (chunk extensions the parser drops): past either cap the upload is answered 413,
// its connection is closed, its in-flight slot is freed and nothing is stored.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-bodycap-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_PLAYER_RATE_MAX = "100000";
  process.env.UPLOAD_ROOM_RATE_MAX = "100000";
  return dir;
});

const BOUNDARY = "exposeme-bodycap-boundary";
const PADDING_CHUNK = Buffer.alloc(64 * 1024, "x");
/** Padding sent around the photo: comfortably past the cap. */
const PADDING_BYTES = MAX_UPLOAD_BODY_BYTES + 1024 * 1024;

const harness = useTestServer();
let auth: Record<string, string> = {};
let jpeg: Buffer;

/** `bytes` of filler that multer skips when sent before the first boundary or after the closing one. */
function padding(bytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let left = bytes; left > 0; left -= PADDING_CHUNK.length) {
    chunks.push(PADDING_CHUNK.subarray(0, Math.min(left, PADDING_CHUNK.length)));
  }
  return chunks;
}

const photoPart = () =>
  Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

interface ChunkedResult {
  /** null when the connection was reset before the response could be read. */
  status: number | null;
  body: string;
  connection?: string;
}

/**
 * Sends `pieces` as a chunked body (no Content-Length), honouring backpressure, and ends it unless `end` is false.
 * Resolves with the response, or with a null status if the server closes the connection before it is read.
 */
function chunkedUpload(pieces: Buffer[], { end = true } = {}): Promise<ChunkedResult> {
  return new Promise((resolve) => {
    const result: ChunkedResult = { status: null, body: "" };
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(result); } };
    const req = http.request({
      host: "127.0.0.1",
      port: harness.port,
      method: "POST",
      path: "/upload",
      headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "Transfer-Encoding": "chunked" },
    });
    req.on("response", (res) => {
      result.status = res.statusCode ?? 0;
      result.connection = res.headers.connection;
      res.setEncoding("utf8");
      res.on("data", (c) => (result.body += c));
      res.on("end", settle);
      res.on("error", settle);
    });
    req.on("error", () => setTimeout(settle, 200)); // let a response that is already arriving be read
    req.on("close", () => setTimeout(settle, 200));

    const queue = [...pieces];
    const writeNext = () => {
      while (queue.length) {
        if (req.destroyed) return;
        if (!req.write(queue.shift()!)) return void req.once("drain", writeNext);
      }
      if (end) req.end();
    };
    writeNext();
  });
}

/** A 1-byte chunk carrying a long chunk extension: ~4 KB on the wire for 1 byte of body. */
const PADDED_CHUNK = Buffer.from(`1;pad=${"a".repeat(4_000)}\r\nx\r\n`);
/** Enough padded chunks to pass the wire cap even if the first read (headers + some body) isn't counted. */
const PADDED_CHUNKS = Math.ceil((MAX_UPLOAD_WIRE_BYTES + 128 * 1024) / PADDED_CHUNK.length);

/**
 * Raw chunked upload (http.request can't send chunk extensions): headers, then `chunks` written with backpressure and
 * left open. Resolves with what the server sent back within `waitMs`, and whether it closed the connection.
 */
function rawChunkedUpload(chunks: number, waitMs = 3_000): Promise<{ response: string; closed: boolean }> {
  return new Promise((resolve) => {
    let response = "";
    let closed = false;
    const socket = net.connect(harness.port, "127.0.0.1");
    const finish = () => { socket.destroy(); resolve({ response, closed }); };
    const timer = setTimeout(finish, waitMs);
    socket.setEncoding("latin1");
    socket.on("data", (d: string) => (response += d));
    socket.on("error", () => {}); // reset while still writing
    socket.on("close", () => { closed = true; clearTimeout(timer); setTimeout(finish, 50); });
    const head = Object.entries({ ...auth, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` })
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.write(`POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n${head}\r\n`);
    let left = chunks;
    const writeNext = () => {
      while (left > 0 && !socket.destroyed) {
        left--;
        if (!socket.write(PADDED_CHUNK)) return void socket.once("drain", writeNext);
      }
    };
    writeNext();
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const storedFiles = () => (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []);

beforeAll(async () => {
  const { room, rejoinToken } = await harness.joinAs(await harness.newClient(), null, "Alice");
  auth = { Authorization: `Bearer ${rejoinToken!}`, "X-Game-Code": room!.gameCode };
  jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
});

afterEach(async () => {
  await waitFor(() => uploadInFlightLimit.inFlight().total === 0);
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

const expectSlotFreed = async () => {
  await waitFor(() => uploadInFlightLimit.inFlight().total === 0);
  expect(uploadInFlightLimit.inFlight()).toEqual({ total: 0, ips: 0, rooms: 0, members: 0 });
};

describe("chunked upload body cap", () => {
  it("still accepts a normal chunked upload", async () => {
    const res = await chunkedUpload([photoPart()]);
    expect(res.status).toBe(200);
    const { url } = JSON.parse(res.body) as { url: string };
    expect(storedFiles()).toContain(url.replace("/temp/", ""));
  });

  it("answers 413 and closes the connection as soon as the body passes the cap, without waiting for its end", async () => {
    const res = await chunkedUpload(padding(MAX_UPLOAD_BODY_BYTES + 1), { end: false });
    expect(res.status).toBe(413);
    expect(res.connection).toBe("close");
    expect(JSON.parse(res.body)).toEqual({ error: "File too large" });
    await expectSlotFreed();
  });

  it.each([
    ["a preamble before the first boundary", () => [...padding(PADDING_BYTES), photoPart()]],
    ["an epilogue after the closing boundary", () => [photoPart(), ...padding(PADDING_BYTES)]],
  ])("refuses a whole chunked body over the cap with %s: slot freed, nothing stored", async (_what, body) => {
    const before = new Set(storedFiles());
    const res = await chunkedUpload(body());
    // The connection is closed while the client is still sending, so the 413 may be lost to the reset
    expect([413, null]).toContain(res.status);
    await expectSlotFreed();
    expect(storedFiles().filter((f) => !before.has(f))).toEqual([]);
  });

  it("answers 413 and closes the connection once the bytes on the wire pass their cap, however little body they carry", async () => {
    const { response, closed } = await rawChunkedUpload(PADDED_CHUNKS);
    // ~5 MB on the wire for ~1,300 bytes of body: only the wire count can catch it
    expect(PADDED_CHUNKS).toBeLessThan(MAX_UPLOAD_BODY_BYTES / 1_000);
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response).toMatch(/\r\nConnection: close\r\n/i);
    expect(response).toContain(JSON.stringify({ error: "File too large" }));
    expect(closed).toBe(true);
    await expectSlotFreed();
  });

  it("keeps accepting uploads afterwards", async () => {
    const res = await chunkedUpload([photoPart()]);
    expect(res.status).toBe(200);
  });
});
