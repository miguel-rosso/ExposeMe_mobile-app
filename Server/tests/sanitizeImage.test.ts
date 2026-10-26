import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createLimiter, headerSize, ImageRejected, MAX_INPUT_PIXELS, sanitizeImage, sniffFormat } from "../controllers/sanitizeImage";

const HEIC_FIXTURE = path.join(__dirname, "fixtures/gps.heic"); // synthetic 64x48 HEIC

const tiny = (format: "jpeg" | "png" | "webp" | "gif" | "tiff" | "avif") =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } })[format]().toBuffer();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sniffFormat (magic bytes)", () => {
  it("recognises JPEG, PNG and WebP", async () => {
    expect(sniffFormat(await tiny("jpeg"))).toBe("jpeg");
    expect(sniffFormat(await tiny("png"))).toBe("png");
    expect(sniffFormat(await tiny("webp"))).toBe("webp");
  });

  it("returns null for HEIC, GIF, TIFF, AVIF, SVG and junk", async () => {
    expect(sniffFormat(fs.readFileSync(HEIC_FIXTURE))).toBeNull();
    for (const f of ["gif", "tiff", "avif"] as const) expect(sniffFormat(await tiny(f))).toBeNull();
    expect(sniffFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe("headerSize", () => {
  it("matches sharp for JPEG, PNG and every WebP variant (VP8, VP8L, VP8X)", async () => {
    const base = sharp({ create: { width: 37, height: 21, channels: 3, background: "#123" } });
    const samples: Array<["jpeg" | "png" | "webp", Buffer]> = [
      ["jpeg", await base.clone().jpeg().toBuffer()],
      ["jpeg", await base.clone().jpeg({ progressive: true }).withExif({ IFD0: { Make: "X" } }).toBuffer()],
      ["png", await base.clone().png().toBuffer()],
      ["webp", await base.clone().webp().toBuffer()], // VP8
      ["webp", await base.clone().webp({ lossless: true }).toBuffer()], // VP8L
      ["webp", await base.clone().webp().withExif({ IFD0: { Make: "X" } }).toBuffer()], // VP8X
    ];
    for (const [format, buf] of samples) expect(headerSize(buf, format)).toEqual({ width: 37, height: 21 });
  });

  it("returns null for truncated headers", () => {
    expect(headerSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "jpeg")).toBeNull();
    expect(headerSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png")).toBeNull();
    expect(headerSize(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), "webp")).toBeNull();
  });
});

describe("sanitizeImage", () => {
  it("refuses oversized PNG/WebP from the header alone, without calling sharp", async () => {
    const png = Buffer.from(await tiny("png"));
    png.writeUInt32BE(7000, 16);
    png.writeUInt32BE(7000, 20);
    const webp = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).webp().withExif({ IFD0: { Make: "X" } }).toBuffer());
    webp.writeUIntLE(6999, 24, 3); // VP8X canvas 7000x7000
    webp.writeUIntLE(6999, 27, 3);
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    await expect(sanitizeImage(png)).rejects.toMatchObject({ status: 413 });
    await expect(sanitizeImage(webp)).rejects.toMatchObject({ status: 413 });
    expect(metadata).not.toHaveBeenCalled();
    metadata.mockRestore();
  });

  it("refuses non-allowlisted formats with 415 before sharp parses them", async () => {
    const inputs = [fs.readFileSync(HEIC_FIXTURE), await tiny("gif"), await tiny("tiff"), Buffer.from("<svg/>")];
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    for (const input of inputs) await expect(sanitizeImage(input)).rejects.toMatchObject({ status: 415 });
    expect(metadata).not.toHaveBeenCalled();
    metadata.mockRestore();
  });

  it("refuses a header claiming more than MAX_INPUT_PIXELS with 413", async () => {
    const buf = Buffer.from(await tiny("jpeg"));
    const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
    buf.writeUInt16BE(5000, sof + 5); // height
    buf.writeUInt16BE(5000, sof + 7); // width
    expect(5000 * 5000).toBeGreaterThan(MAX_INPUT_PIXELS);
    await expect(sanitizeImage(buf)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a JPEG header with no decodable image with 400", async () => {
    await expect(sanitizeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).rejects.toMatchObject({ status: 400 });
  });
});

describe("createLimiter", () => {
  it("runs at most maxConcurrent jobs, queues maxQueued and refuses the rest with 503 + Retry-After", async () => {
    const run = createLimiter({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 5_000 });
    const order: string[] = [];
    let active = 0, maxActive = 0;
    const job = (name: string, ms: number) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      await sleep(ms);
      active--; order.push(name);
      return name;
    };
    const a = run(job("a", 100));
    const b = run(job("b", 10));
    const err = await run(job("c", 10)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageRejected);
    expect(err).toMatchObject({ status: 503 });
    expect((err as ImageRejected).retryAfterS).toBeGreaterThan(0);
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(order).toEqual(["a", "b"]);
    expect(maxActive).toBe(1);
    await expect(run(job("d", 1))).resolves.toBe("d"); // free again
  });

  it("gives up with 503 when a queued job waits longer than queueTimeoutMs", async () => {
    const run = createLimiter({ maxConcurrent: 1, maxQueued: 4, queueTimeoutMs: 50 });
    const a = run(() => sleep(300).then(() => "a"));
    const t0 = Date.now();
    await expect(run(async () => "b")).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - t0).toBeLessThan(250);
    await expect(a).resolves.toBe("a");
  });

  it("EXP-178: a waiting job whose signal aborts leaves the queue without running and frees its place", async () => {
    const run = createLimiter({ maxConcurrent: 1, maxQueued: 1, queueTimeoutMs: 5_000 });
    let finishA!: (v: string) => void;
    const a = run(() => new Promise<string>((r) => { finishA = r; })); // holds the only slot until resolved
    const gone = new AbortController();
    let ranB = false;
    const b = run(async () => { ranB = true; return "b"; }, gone.signal);
    expect(run.stats()).toEqual({ running: 1, queued: 1 });
    gone.abort();
    await expect(b).rejects.toBeInstanceOf(ImageRejected);
    expect(run.stats()).toEqual({ running: 1, queued: 0 });
    const c = run(async () => "c"); // the place b held is free again
    expect(run.stats()).toEqual({ running: 1, queued: 1 });
    finishA("a");
    expect(await Promise.all([a, c])).toEqual(["a", "c"]);
    expect(ranB).toBe(false);
    expect(run.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("EXP-178: an already aborted signal is rejected without taking a slot", async () => {
    const run = createLimiter({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 50 });
    const gone = new AbortController();
    gone.abort();
    await expect(run(async () => "x", gone.signal)).rejects.toBeInstanceOf(ImageRejected);
    expect(run.stats()).toEqual({ running: 0, queued: 0 });
    await expect(run(async () => "ok")).resolves.toBe("ok");
  });

  it("releases the slot when a job throws", async () => {
    const run = createLimiter({ maxConcurrent: 1, maxQueued: 0, queueTimeoutMs: 50 });
    await expect(run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(run(async () => "ok")).resolves.toBe("ok");
  });
});
