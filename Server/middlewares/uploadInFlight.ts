import { NextFunction, Request, Response } from "express";
import { clientIp, envInt, memberKey, UploadMemberLocals } from "./rateLimit";
import { MAX_FILE_SIZE } from "./upload";

// ── Concurrency caps for POST /upload ──
// multer buffers each upload in memory (up to MAX_FILE_SIZE) before sanitizeImage's own queue applies, and the
// per-member / per-room rate limits count requests per minute, not concurrent ones. These caps bound how many uploads
// are being *received at once* (concurrency, not rate), so slow uploads can't pile up buffers or starve other rooms:
// - uploadDeclaredSize runs first and refuses a declared oversize body (413) without taking any slot;
// - uploadInFlightLimit runs right after requireUploadMember (only authenticated members take slots) and before any
//   byte of the body is read: per member, per room, per IP (429) and server-wide (503);
// - every admitted upload must be fully received within UPLOAD_REQUEST_TIMEOUT_MS (408 and the connection is closed),
//   so a slow sender can't hold a slot longer than that. Processing a complete body is not timed here (the slot is
//   kept until the response; sanitizeImage's queue is sized to UPLOAD_INFLIGHT_MAX, so an upload admitted here is
//   never refused there, and a job whose client is gone leaves that queue with its slot).
// Worst-case buffered memory ≈ UPLOAD_INFLIGHT_MAX × MAX_FILE_SIZE (32 × 5 MB = 160 MB by default).
// A full party (12 players) shares one public IP and one room, so the per-IP and per-room defaults fit all of them
// uploading at once on a quiet server. Once UPLOAD_INFLIGHT_BUSY_SHARE of the server-wide slots are taken, an IP only
// gets new slots while it holds fewer than UPLOAD_INFLIGHT_PER_IP_BUSY_MAX, so holding every slot needs several IPs
// (6 by default: 12 + 4 to reach half, then 4 each) instead of 3; a refused upload carries Retry-After.

export const UPLOAD_INFLIGHT_MAX = envInt("UPLOAD_INFLIGHT_MAX", 32, 1, 10_000);
export const UPLOAD_INFLIGHT_PER_IP_MAX = envInt("UPLOAD_INFLIGHT_PER_IP_MAX", 12, 1, 10_000);
export const UPLOAD_INFLIGHT_PER_IP_BUSY_MAX = envInt("UPLOAD_INFLIGHT_PER_IP_BUSY_MAX", 4, 1, 10_000);
/** Share of UPLOAD_INFLIGHT_MAX in flight from which the server is busy and UPLOAD_INFLIGHT_PER_IP_BUSY_MAX applies. */
export const UPLOAD_INFLIGHT_BUSY_SHARE = 0.5;
export const UPLOAD_INFLIGHT_PER_ROOM_MAX = envInt("UPLOAD_INFLIGHT_PER_ROOM_MAX", 12, 1, 10_000);
export const UPLOAD_INFLIGHT_PER_MEMBER_MAX = envInt("UPLOAD_INFLIGHT_PER_MEMBER_MAX", 2, 1, 10_000);
export const UPLOAD_REQUEST_TIMEOUT_MS = envInt("UPLOAD_REQUEST_TIMEOUT_MS", 20_000, 1_000, 300_000);

/** Multipart boundaries and part headers on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;
const RETRY_AFTER_S = "2";

/** 413 for a declared body that can't fit, before reading it (multer still enforces the limit on chunked bodies). */
export function uploadDeclaredSize(req: Request, res: Response, next: NextFunction) {
  const declared = Number(req.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE + MULTIPART_OVERHEAD) {
    res.setHeader("Connection", "close");
    return void res.status(413).json({ error: "File too large" });
  }
  next();
}

/** Counters per key that drop the key at zero, so idle keys never accumulate. */
function createCounter() {
  const counts = new Map<string, number>();
  return {
    get: (key: string) => counts.get(key) ?? 0,
    inc: (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1),
    dec: (key: string) => {
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else counts.delete(key);
    },
    size: () => counts.size,
  };
}

export function createInFlightLimiter(opts: {
  max: number;
  perIpMax: number;
  /** Per-IP cap once the server is busy (UPLOAD_INFLIGHT_BUSY_SHARE of `max` in flight); default: perIpMax. */
  perIpBusyMax?: number;
  perRoomMax: number;
  perMemberMax: number;
  timeoutMs: number;
}) {
  let total = 0;
  const busyAt = Math.ceil(opts.max * UPLOAD_INFLIGHT_BUSY_SHARE);
  const perIpBusyMax = Math.min(opts.perIpBusyMax ?? opts.perIpMax, opts.perIpMax);
  /** Slots an IP may hold right now: its full share on a quiet server, a smaller one once the server is busy. */
  const ipLimit = () => (total >= busyAt ? perIpBusyMax : opts.perIpMax);
  const perIp = createCounter();
  const perRoom = createCounter();
  const perMember = createCounter();

  const refuse = (res: Response, status: 429 | 503, scope: string) => {
    res.setHeader("Retry-After", RETRY_AFTER_S);
    res.setHeader("Connection", "close");
    res.status(status).json({ error: status === 503 ? "Server busy" : "Too many uploads in progress", scope });
  };

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const member = res.locals.member as UploadMemberLocals;
    const { room } = member;
    const ip = clientIp(req);
    const seat = memberKey(member);

    // Most specific first: the response names the knob that refused it
    if (perMember.get(seat) >= opts.perMemberMax) return refuse(res, 429, "member");
    if (perRoom.get(room.gameCode) >= opts.perRoomMax) return refuse(res, 429, "room");
    if (perIp.get(ip) >= ipLimit()) return refuse(res, 429, "ip");
    if (total >= opts.max) return refuse(res, 503, "server");

    total++;
    perIp.inc(ip);
    perRoom.inc(room.gameCode);
    perMember.inc(seat);

    // The whole body must arrive within timeoutMs; then the slot is freed by closing the connection. Only reception
    // is timed: once the body is complete, processing (sanitizeImage queue) runs to its own limits.
    const timer = setTimeout(() => {
      if (req.complete) return;
      if (!res.headersSent) {
        res.setHeader("Connection", "close");
        res.status(408).json({ error: "Upload timed out" });
      }
      res.once("finish", () => req.socket.destroy());
      if (res.writableFinished) req.socket.destroy();
    }, opts.timeoutMs);
    timer.unref();
    req.once("end", () => clearTimeout(timer));

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      total--;
      perIp.dec(ip);
      perRoom.dec(room.gameCode);
      perMember.dec(seat);
    };
    // "close" fires after the response is sent and also when the client aborts mid-upload
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  /** Uploads currently being received (for tests). */
  middleware.inFlight = () => ({ total, ips: perIp.size(), rooms: perRoom.size(), members: perMember.size() });
  return middleware;
}

export const uploadInFlightLimit = createInFlightLimiter({
  max: UPLOAD_INFLIGHT_MAX,
  perIpMax: UPLOAD_INFLIGHT_PER_IP_MAX,
  perIpBusyMax: UPLOAD_INFLIGHT_PER_IP_BUSY_MAX,
  perRoomMax: UPLOAD_INFLIGHT_PER_ROOM_MAX,
  perMemberMax: UPLOAD_INFLIGHT_PER_MEMBER_MAX,
  timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
});
