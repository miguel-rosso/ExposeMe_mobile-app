import type { IncomingMessage, ServerResponse } from "http";

// ── Unread request bodies ──
// Once a response is out, Node reads and discards whatever is left of its request body so the connection can serve
// the next request, with no limit but server.requestTimeout: a chunked body (no Content-Length) answered from its
// headers alone (401/403/404/429, socket.io's 400…) would keep the server reading at full speed for that long. Such a
// body now gets UNREAD_BODY_GRACE_MS to finish arriving, then its connection is closed.
// The connection is not closed right away: the end of a small body is often still being parsed when the response
// finishes (and the next keep-alive request with it), and a client still sending when the connection is reset may never
// read the response it was sent.
// Bodies with limits of their own (admitted uploads: byte cap and upload timeout, see uploadInFlight) are left to them,
// so a member on a slow network still reads an early 403/429 instead of a reset.

/** How long the rest of a body answered before it arrived may take to come in before its connection is closed. */
export const UNREAD_BODY_GRACE_MS = 1_000;

/** Responses whose request body is bounded by its own limits (see markBodyBounded). */
const boundedBodies = new WeakSet<ServerResponse>();
let pendingGraces = 0;

/** This request's body is bounded by its own limits: closeUnreadBodyAfterResponse leaves its connection alone. */
export function markBodyBounded(res: ServerResponse): void {
  boundedBodies.add(res);
}

/** Bodies answered before they arrived and still within their grace period (for tests). */
export const pendingUnreadBodyGraces = () => pendingGraces;

/** 'request' listener of the HTTP server: closes the connection of a request whose body outlives its response. */
export function closeUnreadBodyAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  res.once("finish", () => {
    if (req.complete || boundedBodies.has(res)) return;
    // The timer holds only the socket, and is cancelled as soon as the body ends (Node drains it) or the request closes
    const socket = req.socket;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      pendingGraces--;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      settle();
      socket.destroy();
    }, UNREAD_BODY_GRACE_MS).unref();
    pendingGraces++;
    req.once("end", settle);
    req.once("close", settle);
  });
}
