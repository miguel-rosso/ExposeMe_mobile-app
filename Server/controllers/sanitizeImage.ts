import sharp from "sharp";
import { envInt } from "../middlewares/rateLimit";
import { UPLOAD_INFLIGHT_MAX } from "../middlewares/uploadInFlight";

export type SanitizedExt = "jpg" | "png" | "webp";
type ImageFormat = "jpeg" | "png" | "webp";

// ── Limits ──
/** Largest accepted input, checked from the header before decoding (24 MP; the app sends ≤2048 px JPEGs). */
export const MAX_INPUT_PIXELS = 24_000_000;
/** Output is shrunk to fit in MAX_OUTPUT_SIDE x MAX_OUTPUT_SIDE (never enlarged). */
export const MAX_OUTPUT_SIDE = 2048;
/** Images processed at the same time (decode memory is the bottleneck on a small instance). */
export const SANITIZE_MAX_CONCURRENT = 1;
/**
 * Uploads waiting for a slot; beyond this they get 503 right away. Every waiting job belongs to an upload that still
 * holds its in-flight slot (the slot is kept until the response, and a job whose client is gone leaves the queue), so
 * sizing it to the server-wide in-flight cap means an upload admitted by those caps is never refused here. The queue
 * adds no memory of its own: the buffers it holds are the in-flight ones (≤ UPLOAD_INFLIGHT_MAX × MAX_FILE_SIZE).
 */
export const SANITIZE_MAX_QUEUED = UPLOAD_INFLIGHT_MAX;
/**
 * Backstop for a stuck job: longest wait for a slot before giving up with 503. Long enough for a full queue
 * (32 × a few hundred ms per image on a small instance); the wait is otherwise bounded by the queue length.
 */
export const SANITIZE_QUEUE_TIMEOUT_MS = envInt("SANITIZE_QUEUE_TIMEOUT_MS", 60_000, 1_000, 600_000);
/** Retry-After (seconds) sent with 503. */
export const SANITIZE_RETRY_AFTER_S = 2;

// Keep libvips memory low: no operation cache, one worker thread per image
sharp.cache(false);
sharp.concurrency(1);
// Defence in depth: only the JPEG/PNG/WebP buffer decoders may run (the magic-byte check comes first anyway)
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer", "VipsForeignLoadWebpBuffer"] });

/** The upload is not an acceptable image (or the server is busy); `status` is the HTTP answer. */
export class ImageRejected extends Error {
  constructor(message: string, readonly status = 400, readonly retryAfterS?: number) {
    super(message);
  }
}

// ── Format sniffing ──
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format from the file's magic bytes; null for anything that is not JPEG, PNG or WebP (HEIC, GIF, SVG…). */
export function sniffFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Image size read from the container header without libvips (so oversized images never reach a decoder).
 * null if the header is malformed or incomplete.
 */
export function headerSize(buf: Buffer, format: ImageFormat): { width: number; height: number } | null {
  try {
    if (format === "png") {
      if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (format === "webp") {
      const chunk = buf.toString("latin1", 12, 16);
      if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L" && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X" && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      return null;
    }
    // JPEG: walk the top-level segments (APPn thumbnails are skipped by length) up to the first SOFn
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
      if (marker === 0xda || marker === 0xd9) return null; // scan/end before any frame header
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return i + 9 <= buf.length ? { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) } : null;
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Concurrency limit ──
/**
 * At most `maxConcurrent` jobs run at once; up to `maxQueued` wait (each for at most `queueTimeoutMs`);
 * anything else is refused with ImageRejected 503. A waiting job whose `signal` aborts (client gone) leaves the queue
 * and is rejected without running.
 */
export function createLimiter({ maxConcurrent, maxQueued, queueTimeoutMs }: { maxConcurrent: number; maxQueued: number; queueTimeoutMs: number }) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const busy = () => new ImageRejected("Server busy, try again", 503, SANITIZE_RETRY_AFTER_S);

  const release = () => {
    const start = waiting.shift();
    if (start) start(); // the slot passes straight to the next job
    else running--;
  };

  const aborted = () => new ImageRejected("Upload aborted", 499);

  async function run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw aborted();
    if (running < maxConcurrent) {
      running++;
    } else {
      if (waiting.length >= maxQueued) throw busy();
      await new Promise<void>((resolve, reject) => {
        const leave = (err: ImageRejected) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const i = waiting.indexOf(start);
          if (i !== -1) waiting.splice(i, 1);
          reject(err);
        };
        const onAbort = () => leave(aborted());
        const start = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(); };
        const timer = setTimeout(() => leave(busy()), queueTimeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.push(start);
      });
    }
    try {
      return await job();
    } finally {
      release();
    }
  }
  /** Jobs running and waiting (for tests). */
  run.stats = () => ({ running, queued: waiting.length });
  return run;
}

export const limit = createLimiter({
  maxConcurrent: SANITIZE_MAX_CONCURRENT,
  maxQueued: SANITIZE_MAX_QUEUED,
  queueTimeoutMs: SANITIZE_QUEUE_TIMEOUT_MS,
});

// ── Re-encode ──
async function reencode(input: Buffer, format: ImageFormat): Promise<{ data: Buffer; ext: SanitizedExt }> {
  // failOn "none": tolerate slightly truncated files like a browser would; sequentialRead: stream the decode
  const image = sharp(input, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true });
  // metadata() only reads the header; it already enforces limitInputPixels
  const meta = await image.metadata().catch((err: Error) => {
    throw /exceeds pixel limit/i.test(err.message) ? new ImageRejected("Image too large", 413) : new ImageRejected("Invalid image");
  });
  if (meta.format !== format) throw new ImageRejected("Invalid image");
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) throw new ImageRejected("Image too large", 413);

  // The bounding box is square, so resizing before or after applying the orientation gives the same size;
  // resize first lets JPEG/WebP decode at a reduced scale (shrink-on-load).
  const pipeline = image
    .resize({ width: MAX_OUTPUT_SIDE, height: MAX_OUTPUT_SIDE, fit: "inside", withoutEnlargement: true })
    .rotate();
  try {
    if (format === "png") return { data: await pipeline.png().toBuffer(), ext: "png" };
    if (format === "webp") return { data: await pipeline.webp().toBuffer(), ext: "webp" };
    return { data: await pipeline.jpeg({ quality: 90 }).toBuffer(), ext: "jpg" };
  } catch {
    throw new ImageRejected("Invalid image");
  }
}

/**
 * Turn an uploaded image into a resized copy without metadata (EXIF incl. GPS, XMP, IPTC, ICC — sharp keeps
 * none by default), orientation applied to the pixels. The declared MIME type and file name are not trusted:
 * the format comes from the magic bytes, and only JPEG, PNG and WebP are accepted (415 otherwise, e.g. HEIC —
 * the app converts photos to JPEG before uploading).
 */
export async function sanitizeImage(input: Buffer, signal?: AbortSignal): Promise<{ data: Buffer; ext: SanitizedExt }> {
  const format = sniffFormat(input);
  if (!format) throw new ImageRejected("Unsupported image format (use JPEG, PNG or WebP)", 415);
  const size = headerSize(input, format);
  if (!size || !size.width || !size.height) throw new ImageRejected("Invalid image");
  if (size.width * size.height > MAX_INPUT_PIXELS) throw new ImageRejected("Image too large", 413);
  return limit(() => reencode(input, format), signal);
}
