import type { IncomingMessage, ServerResponse } from "http";

// ── Unread request bodies ──
// Once a response is out, Node reads and discards whatever is left of its request body so the connection can serve
// the next request, with no limit but server.requestTimeout: a chunked body (no Content-Length) answered from its
// headers alone (401/403/404/429, socket.io's 400…) would keep the server reading at full speed for that long. Such a
// body now gets UNREAD_BODY_GRACE_MS to finish arriving, then its connection is closed; and it may take at most
// UNREAD_BODY_MAX_BYTES off the connection meanwhile, since in that time alone a fast client sends gigabytes. Node
// discards such a body without handing it over, so it is read (and counted) here instead.
// The connection is not closed right away: the end of a small body is often still being parsed when the response
// finishes (and the next keep-alive request with it), and a client still sending when the connection is reset may never
// read the response it was sent.
// Bodies with limits of their own (admitted uploads: byte cap and upload timeout, see uploadInFlight) are left to them,
// so a member on a slow network still reads an early 403/429 instead of a reset.

/** How long the rest of a body answered before it arrived may take to come in before its connection is closed. */
export const UNREAD_BODY_GRACE_MS = 1_000;

/** Most bytes the rest of a body answered before it arrived may take off the connection before it is closed. */
export const UNREAD_BODY_MAX_BYTES = 1024 * 1024;

/** Responses whose request body is bounded by its own limits (see markBodyBounded). */
const boundedBodies = new WeakSet<ServerResponse>();
let pendingGraces = 0;

/** This request's body is bounded by its own limits: closeUnreadBodyAfterResponse leaves its connection alone. */
export function markBodyBounded(res: ServerResponse): void {
  boundedBodies.add(res);
}

/**
 * How long a connection that went over its unread-body byte cap stays open, no longer read, before it is closed: a
 * socket closed with unread data is reset, and the reset can make the client drop a response it hasn't read yet.
 */
export const OVER_CAP_CLOSE_DELAY_MS = 250;

/** Bodies answered before they arrived and still within their grace period (for tests). */
export const pendingUnreadBodyGraces = () => pendingGraces;

/**
 * Reads (and discards) the rest of `req`'s body; once more than `maxBytes` have been read off its connection from now
 * on, stops reading it (the kernel's buffers bound what the client can still send) and closes it
 * OVER_CAP_CLOSE_DELAY_MS later. Call it before the response is out (or while something already reads the body): once
 * it is, Node discards a body nobody reads itself, uncounted.
 */
export function capUnreadBody(req: IncomingMessage, maxBytes: number): void {
  const socket = req.socket;
  const readBefore = socket.bytesRead;
  const onData = () => {
    if (socket.bytesRead - readBefore <= maxBytes) return;
    req.off("data", onData);
    stopReading(req);
    const timer = setTimeout(() => socket.destroy(), OVER_CAP_CLOSE_DELAY_MS).unref();
    socket.once("close", () => clearTimeout(timer));
  };
  req.on("data", onData);
}

/**
 * Stops reading `req`'s connection. Pausing the socket alone doesn't: the request resumes it whenever it is read, so the
 * request is paused too, and whatever it is piped into (multer) is detached so that it can't resume it.
 */
function stopReading(req: IncomingMessage): void {
  req.unpipe();
  req.pause();
  req.socket.pause();
}

/** 'request' listener of the HTTP server: closes the connection of a request whose body outlives its response. */
export function closeUnreadBodyAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  // "prefinish": the response is complete but not flushed yet, so Node hasn't discarded the unread body yet
  res.once("prefinish", () => {
    if (!req.complete && !boundedBodies.has(res)) capUnreadBody(req, UNREAD_BODY_MAX_BYTES);
  });
  res.once("finish", () => {
    if (req.complete || boundedBodies.has(res)) return;
    // The timer holds only the socket, and is cancelled as soon as the body ends or the connection closes (the request
    // emits nothing then, its response being out); a keep-alive connection doesn't keep the listener
    const socket = req.socket;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      pendingGraces--;
      clearTimeout(timer);
      req.off("end", settle);
      socket.off("close", settle);
    };
    const timer = setTimeout(() => {
      settle();
      socket.destroy();
    }, UNREAD_BODY_GRACE_MS).unref();
    pendingGraces++;
    req.once("end", settle);
    socket.once("close", settle);
  });
}
