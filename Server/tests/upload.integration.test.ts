import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import exifr from "exifr";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { UPLOAD_RATE_MAX } from "../middlewares/rateLimit";
import { MAX_OUTPUT_SIDE } from "../controllers/sanitizeImage";
import { MAX_FILE_SIZE } from "../middlewares/upload";

// POST /upload on a real server: random file names, metadata stripped, size limits, per-IP rate limit,
// and the returned paths are accepted by photo-sent.

// Uploads go to a throwaway directory (set before ../app and middlewares/upload, which creates it, are loaded)
const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-test-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  delete process.env.UPLOAD_RATE_MAX; // default limit, even if the shell exports a lab override
  delete process.env.UPLOAD_RATE_WINDOW_MS;
  return dir;
});

const UPLOAD_PATH_RE = /^\/temp\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;
const LEAKY_NAME = "Screenshot_20261024-231502_Bank Santander.jpg";
const HEIC_FIXTURE = path.join(__dirname, "fixtures/gps.heic"); // synthetic 64x48 HEIC with GPS EXIF

let url: string;
let uploadsDone = 0; // every POST /upload counts towards the rate limit (shared IP in this file)
const clients: ClientSocket[] = [];

// Synthetic JPEG with GPS + device EXIF, 64x48 pixels stored with orientation 6 (display 48x64)
async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 60 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: "TestPhone", Model: "Galaxy Test" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 25/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "3/1 42/1 0/1" },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

// Uploads need a room member's credentials (a lobby room created in beforeAll; see uploadAccess.integration.test.ts)
let auth: Record<string, string> = {};

async function uploadFile(data: Buffer, filename: string, type = "image/jpeg", headers = auth) {
  uploadsDone++;
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(data)], { type }), filename);
  return fetch(`${url}/upload`, { method: "POST", body: form, headers });
}

async function fetchUploaded(res: Response, headers = auth): Promise<{ path: string; body: Buffer }> {
  expect(res.status).toBe(200);
  const { url: p } = (await res.json()) as { url: string };
  const got = await fetch(`${url}${p}`, { headers });
  expect(got.status).toBe(200);
  return { path: p, body: Buffer.from(await got.arrayBuffer()) };
}

/** True if the JPEG has an APP1 segment (EXIF/XMP) before the image data. */
function hasApp1(jpeg: Buffer): boolean {
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xe1) return true;
    if (marker === 0xda) return false; // start of scan
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return false;
}

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = await newClient();
  const created = once<{ room: { gameCode: string }; rejoinToken: string }>(host, "room-of-game");
  host.emit("join-create-game", { gameCode: null, username: "uploader" });
  const { room, rejoinToken } = await created;
  auth = { Authorization: `Bearer ${rejoinToken}`, "X-Game-Code": room.gameCode };
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

/** Small JPEG whose SOF header claims width x height (sharp reads the size from the header). */
async function jpegClaiming(width: number, height: number): Promise<Buffer> {
  const buf = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).jpeg().toBuffer());
  const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
  buf.writeUInt16BE(height, sof + 5);
  buf.writeUInt16BE(width, sof + 7);
  return buf;
}

describe("POST /upload", () => {
  it("ignores the original file name: random, unguessable URL", async () => {
    const res = await uploadFile(await gpsJpeg(), LEAKY_NAME);
    const { path: p } = await fetchUploaded(res);
    expect(p).toMatch(UPLOAD_PATH_RE);
    for (const part of ["Screenshot", "20261024", "231502", "Bank", "Santander"]) expect(p).not.toContain(part);

    const second = await fetchUploaded(await uploadFile(await gpsJpeg(), LEAKY_NAME));
    expect(second.path).not.toBe(p);
  });

  it("strips EXIF (GPS, device) from JPEG and applies the orientation to the pixels", async () => {
    const input = await gpsJpeg();
    expect(await exifr.gps(input)).toMatchObject({ latitude: expect.closeTo(40.4167, 3) }); // fixture sanity

    const { path: p, body } = await fetchUploaded(await uploadFile(input, "IMG_0001.jpg"));
    expect(p).toMatch(/\.jpg$/);
    expect(hasApp1(body)).toBe(false);
    expect(await exifr.parse(body)).toBeUndefined();
    const meta = await sharp(body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([48, 64]);
  });

  it("refuses HEIC with 415 JSON, also when declared as image/jpeg", async () => {
    const heic = fs.readFileSync(HEIC_FIXTURE);
    expect(await exifr.gps(heic)).toBeTruthy(); // fixture sanity
    for (const type of ["image/jpeg", "image/heic"]) {
      const res = await uploadFile(heic, "IMG_0002.HEIC", type);
      expect(res.status).toBe(415);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(fs.readdirSync(UPLOAD_DIR).some((f) => !UPLOAD_PATH_RE.test(`/temp/${f}`))).toBe(false);
  });

  it("trusts the bytes, not the declared MIME type", async () => {
    const { path: p } = await fetchUploaded(await uploadFile(await gpsJpeg(), "x.gif", "image/gif"));
    expect(p).toMatch(/\.jpg$/);
  });

  it("keeps PNG and WebP formats without metadata", async () => {
    const base = sharp({ create: { width: 8, height: 8, channels: 3, background: "#0a0" } });
    const png = await base.clone().png().withExif({ IFD0: { Make: "TestPhone" } }).toBuffer();
    const webp = await base.clone().webp().withExif({ IFD0: { Make: "TestPhone" } }).toBuffer();

    const a = await fetchUploaded(await uploadFile(png, "a.png", "image/png"));
    expect(a.path).toMatch(/\.png$/);
    expect((await sharp(a.body).metadata()).exif).toBeUndefined();

    const b = await fetchUploaded(await uploadFile(webp, "b.webp", "image/webp"));
    expect(b.path).toMatch(/\.webp$/);
    expect((await sharp(b.body).metadata()).exif).toBeUndefined();
  });

  it("rejects bytes that are not an image (415)", async () => {
    const res = await uploadFile(Buffer.from("definitely not an image"), "x.jpg");
    expect(res.status).toBe(415);
  });

  it("answers malformed uploads with JSON, never an HTML error page", async () => {
    const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const post = (form: FormData) => { uploadsDone++; return fetch(`${url}/upload`, { method: "POST", body: form, headers: auth }); };
    const expectJson = async (res: Response, status: number) => {
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const text = await res.text();
      expect(text).not.toMatch(/<html|node_modules|at .*\.ts:/i);
    };

    const tooBig = Buffer.concat([tiny, Buffer.alloc(MAX_FILE_SIZE + 1)]);
    await expectJson(await uploadFile(tooBig, "big.jpg"), 413);

    const two = new FormData();
    two.append("image", new Blob([new Uint8Array(tiny)], { type: "image/jpeg" }), "a.jpg");
    two.append("image", new Blob([new Uint8Array(tiny)], { type: "image/jpeg" }), "b.jpg");
    await expectJson(await post(two), 400);

    const wrongField = new FormData();
    wrongField.append("photo", new Blob([new Uint8Array(tiny)], { type: "image/jpeg" }), "a.jpg");
    await expectJson(await post(wrongField), 400);

    await expectJson(await post(new FormData()), 400); // no file
  });

  it("stores files only in the upload dir (UPLOAD_DIR)", () => {
    expect(fs.readdirSync(UPLOAD_DIR).length).toBeGreaterThan(0);
    for (const f of fs.readdirSync(UPLOAD_DIR)) expect(`/temp/${f}`).toMatch(UPLOAD_PATH_RE);
  });

  it("shrinks large images to fit MAX_OUTPUT_SIDE", async () => {
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#456" } }).jpeg().toBuffer();
    const { body } = await fetchUploaded(await uploadFile(big, "big.jpg"));
    const meta = await sharp(body).metadata();
    expect([meta.width, meta.height]).toEqual([MAX_OUTPUT_SIDE, Math.round((1000 * MAX_OUTPUT_SIDE) / 3000)]);
  });

  it("refuses images whose header claims too many pixels (decompression bomb), without decoding them", async () => {
    const t0 = Date.now();
    const res = await uploadFile(await jpegClaiming(16_000, 16_000), "bomb.jpg");
    expect(res.status).toBe(413);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("refuses formats other than JPEG/PNG/WebP (GIF, TIFF, AVIF, SVG) with 415", async () => {
    const base = sharp({ create: { width: 8, height: 8, channels: 3, background: "#789" } });
    const files: Array<[string, Buffer]> = [
      ["x.gif", await base.clone().gif().toBuffer()],
      ["x.tif", await base.clone().tiff().toBuffer()],
      ["x.avif", await base.clone().avif().toBuffer()],
      ["x.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')],
    ];
    for (const [name, data] of files) expect({ name, status: (await uploadFile(data, name)).status }).toEqual({ name, status: 415 });
  });

  it("the owner's uploaded path is accepted by photo-sent", async () => {
    const [alice, bob, carol] = [await newClient(), await newClient(), await newClient()];
    const byName: Record<string, ClientSocket> = { alice, bob, carol };
    const tokens: Record<string, string> = {};
    const created = once<{ room: { gameCode: string }; rejoinToken: string }>(alice, "room-of-game");
    alice.emit("join-create-game", { gameCode: null, username: "alice" });
    const { room: { gameCode }, rejoinToken } = await created;
    tokens.alice = rejoinToken;
    for (const [name, sock] of [["bob", bob], ["carol", carol]] as const) {
      const joined = once<{ success: boolean; rejoinToken: string }>(sock, "room-of-game");
      sock.emit("join-create-game", { gameCode, username: name });
      const j = await joined;
      expect(j.success).toBe(true);
      tokens[name] = j.rejoinToken;
    }
    const started = [alice, bob, carol].map((c) => once(c, "game-started"));
    alice.emit("start-game", { gameCode });
    await Promise.all(started);

    const turn = new Promise<string>((resolve) => {
      for (const [name, sock] of Object.entries(byName)) sock.once("your-turn", () => resolve(name));
    });
    for (const [name, sock] of Object.entries(byName)) sock.emit("im-ready", { gameCode, username: name });
    const owner = await turn;
    const ownerAuth = { Authorization: `Bearer ${tokens[owner]}`, "X-Game-Code": gameCode };
    const { path: photo } = await fetchUploaded(await uploadFile(await gpsJpeg(), LEAKY_NAME, "image/jpeg", ownerAuth), ownerAuth);

    const roundStart = once<{ photo: string; isOwner: boolean }>(alice, "round-start");
    byName[owner].emit("photo-sent", { photo, gameCode });
    expect(await roundStart).toMatchObject({ photo, isOwner: owner === "alice" });

    for (const c of [alice, bob, carol]) c.emit("leave-room");
  });

  it("rate limits uploads per IP (429 once the window is full)", async () => {
    const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).jpeg().toBuffer();
    while (uploadsDone < UPLOAD_RATE_MAX) expect((await uploadFile(tiny, "t.jpg")).status).toBe(200);

    const limited = await uploadFile(tiny, "t.jpg");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
