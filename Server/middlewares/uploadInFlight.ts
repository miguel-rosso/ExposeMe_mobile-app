import { NextFunction, Request, Response } from "express";
import { clientIp, envInt, memberKey, UploadMemberLocals } from "./rateLimit";
import { MAX_FILE_SIZE } from "./upload";
import { capUnreadBody, markBodyBounded, UNREAD_BODY_GRACE_MS } from "./unreadBody";

// ── Concurrency caps for POST /upload ──
// multer buffers each upload in memory (up to MAX_FILE_SIZE) before sanitizeImage's own queue applies, and the
// per-member / per-room rate limits count requests per minute, not concurrent ones. These caps bound how many uploads
// are being *received at once* (concurrency, not rate), so slow uploads can't pile up buffers or starve other rooms:
// - uploadDeclaredSize runs first and refuses a declared oversize body (413) without taking any slot;
// - uploadInFlightLimit runs right after requireUploadMember (only authenticated members take slots) and before any
//   byte of the body is read: per member, per room, per IP (429) and server-wide (503);
// - every admitted upload must be fully received within UPLOAD_REQUEST_TIMEOUT_MS (408 and the connection is closed),
//   so a slow sender can't hold a slot longer than that, and may carry at most MAX_UPLOAD_BODY_BYTES in total, counted
//   as they are read, so a chunked body (no Content-Length) can't pad the photo with bytes multer skips (413 and the
//   connection is closed). Processing a complete body is not timed here (the slot is kept until the response is out
//   and the body has stopped arriving, see below; sanitizeImage's queue is sized to UPLOAD_INFLIGHT_MAX, so an upload
//   admitted here is never refused there, and a job whose client is gone leaves that queue with its slot);
// - the slot is held until the response is out *and* the body has stopped arriving: an upload answered early (403/429
//   after admission) keeps its slot and its timeout while the rest of its body drains, so a member can't keep more than
//   UPLOAD_INFLIGHT_PER_MEMBER_MAX bodies draining at once, nor any for longer than the upload timeout;
// - every refusal or cut (413/429/503/408) closes the connection without losing the answer to a reset, and reads at most
//   LINGER_MAX_BYTES more meanwhile (see closeAfterResponse).
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
/** Most bytes a whole /upload body may carry, declared (Content-Length) or not (chunked). */
export const MAX_UPLOAD_BODY_BYTES = MAX_FILE_SIZE + MULTIPART_OVERHEAD;
/** Chunked-encoding framing (chunk sizes, CRLFs, trailers) a real client adds on top of the body: ~0.1% at 8 KB chunks. */
const CHUNKED_FRAMING_ALLOWANCE = 64 * 1024;
/**
 * Most bytes an upload may take off the wire after admission. Bounds what the HTTP parser reads but never hands over
 * as body (e.g. chunk extensions around 1-byte chunks), which the decoded count alone doesn't see.
 */
export const MAX_UPLOAD_WIRE_BYTES = MAX_UPLOAD_BODY_BYTES + CHUNKED_FRAMING_ALLOWANCE;
const RETRY_AFTER_S = "2";

/**
 * Most bytes a client may still send once its upload was refused or cut (see closeAfterResponse): a whole upload, so a
 * client finishing a photo it had already started sending reads the answer rather than a reset.
 */
const LINGER_MAX_BYTES = MAX_UPLOAD_WIRE_BYTES;

/** 413 for a declared body that can't fit, before reading it (a chunked body is counted as it arrives, see capBodyBytes). */
export function uploadDeclaredSize(req: Request, res: Response, next: NextFunction) {
  const declared = Number(req.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) {
    return void answerAndClose(req, res, 413, { error: "File too large" });
  }
  next();
}

/**
 * Closes the connection once the response is out without losing it to a reset ("lingering close", RFC 9112 §9.6):
 * a socket closed while the client is still sending is reset, which can discard the response before the client reads
 * it. Our side is ended right after the response instead, so the client reads it and then the end of the stream; what
 * it still sends is read and discarded for UNREAD_BODY_GRACE_MS, LINGER_MAX_BYTES at most, then the connection is
 * closed. Call it before the response is out (see capUnreadBody), or after it if the body was being read already.
 */
function closeAfterResponse(req: Request, res: Response) {
  const socket = req.socket;
  // Bounded here: the generic unread-body grace (middlewares/unreadBody) leaves it alone
  markBodyBounded(res);
  capUnreadBody(req, LINGER_MAX_BYTES);
  // Once a `Connection: close` response is written, Node's HTTP server calls destroySoon(), which ends our side and
  // destroys the socket as soon as that is flushed: here it only ends it, and linger() destroys it later
  socket.destroySoon = () => socket.end();
  const linger = () => {
    socket.end();
    const timer = setTimeout(() => socket.destroy(), UNREAD_BODY_GRACE_MS).unref();
    socket.once("close", () => clearTimeout(timer));
  };
  if (res.writableFinished) linger();
  else res.once("finish", linger);
}

/** Answers `status` with `body` and closes the connection once the response is out (see closeAfterResponse). */
function answerAndClose(req: Request, res: Response, status: number, body: object) {
  closeAfterResponse(req, res);
  // Also keeps the client from reusing the connection
  res.setHeader("Connection", "close");
  res.status(status).json(body);
}

/** Answers `status` (unless already answered), then closes the connection once the response is out. */
function abortUpload(req: Request, res: Response, status: 408 | 413, error: string) {
  if (res.headersSent) closeAfterResponse(req, res);
  else answerAndClose(req, res, status, { error });
}

/**
 * Counts the body bytes as they are read (by multer, or by the drain after an early answer) and aborts the upload with
 * 413 once they pass MAX_UPLOAD_BODY_BYTES, or once the bytes read off the connection since admission pass
 * MAX_UPLOAD_WIRE_BYTES. A chunked body declares no size, multer only limits the photo part (not a preamble or epilogue
 * it skips), and the HTTP parser drops chunk extensions before they reach the body.
 */
function capBodyBytes(req: Request, res: Response) {
  // Per connection: a keep-alive socket has already read the earlier requests (and this one's head)
  const wireAtAdmission = req.socket.bytesRead;
  let bodyBytes = 0;
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    bodyBytes += chunk.length;
    const wireBytes = req.socket.bytesRead - wireAtAdmission;
    if (aborted || (bodyBytes <= MAX_UPLOAD_BODY_BYTES && wireBytes <= MAX_UPLOAD_WIRE_BYTES)) return;
    aborted = true;
    abortUpload(req, res, 413, "File too large");
  });
  // Listening alone would start the flow before multer pipes the body, so the stream is paused until then. Having
  // started to read it (on('data') schedules a read) also keeps Node from _dump()-ing an unread body when a later
  // middleware answers early: _dump() removes every 'data' listener, which would drop this counter. Such a body is
  // drained here instead, still counted.
  req.pause();
  res.once("finish", () => {
    if (!req.complete) req.resume();
  });
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

  const refuse = (req: Request, res: Response, status: 429 | 503, scope: string) => {
    res.setHeader("Retry-After", RETRY_AFTER_S);
    answerAndClose(req, res, status, { error: status === 503 ? "Server busy" : "Too many uploads in progress", scope });
  };

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const member = res.locals.member as UploadMemberLocals;
    const { room } = member;
    const ip = clientIp(req);
    const seat = memberKey(member);

    // Most specific first: the response names the knob that refused it
    if (perMember.get(seat) >= opts.perMemberMax) return refuse(req, res, 429, "member");
    if (perRoom.get(room.gameCode) >= opts.perRoomMax) return refuse(req, res, 429, "room");
    if (perIp.get(ip) >= ipLimit()) return refuse(req, res, 429, "ip");
    if (total >= opts.max) return refuse(req, res, 503, "server");

    total++;
    perIp.inc(ip);
    perRoom.inc(room.gameCode);
    perMember.inc(seat);

    // The whole body must arrive within timeoutMs; then the slot is freed by closing the connection, also when the
    // upload was already answered (its body still draining). Only reception
    // is timed: once the body is complete, processing (sanitizeImage queue) runs to its own limits.
    const timer = setTimeout(() => {
      if (!req.complete) abortUpload(req, res, 408, "Upload timed out");
    }, opts.timeoutMs);
    timer.unref();
    req.once("end", () => clearTimeout(timer));
    capBodyBytes(req, res);
    // Answered early (403/429 after admission), its body is drained under this byte cap and the upload timeout (its
    // slot is held meanwhile) rather than cut after the unread-body grace period, so a member on a slow network still
    // reads the answer (see middlewares/unreadBody)
    markBodyBounded(res);

    const release = () => {
      clearTimeout(timer);
      total--;
      perIp.dec(ip);
      perRoom.dec(room.gameCode);
      perMember.dec(seat);
    };
    // Once the response is out (or the client aborted), the slot waits for the rest of the body to arrive or for the
    // connection to close (upload timeout, byte cap, client gone). The request emits nothing when its connection closes
    // after its response, hence the socket listener.
    let answered = false;
    const releaseOnceBodyStops = () => {
      if (answered) return;
      answered = true;
      if (req.complete || req.socket.destroyed) return release();
      // Removed from the socket once done: a keep-alive connection outlives its requests
      const bodyStopped = () => {
        req.off("end", bodyStopped);
        req.socket.off("close", bodyStopped);
        release();
      };
      req.once("end", bodyStopped);
      req.socket.once("close", bodyStopped);
    };
    // "close" fires after the response is sent and also when the client aborts mid-upload
    res.once("finish", releaseOnceBodyStops);
    res.once("close", releaseOnceBodyStops);
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
