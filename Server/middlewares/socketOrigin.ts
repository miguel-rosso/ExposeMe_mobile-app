import type { IncomingMessage, ServerResponse } from "http";

// ── Socket request origin check ──
// CORS doesn't apply to WebSockets, so without this check any website could open game sockets from its visitors'
// browsers. Browsers always send `Origin` on a WebSocket handshake and on cross-origin POSTs, so every engine.io
// request (handshake, long-polling GET/POST of an open session, WebSocket upgrade) is accepted only when:
// - it has no Origin: Node bots, and React Native's XHR long-polling (OkHttp / NSURLSession don't add one);
// - its Origin names the same host as the request: React Native's native WebSocket derives Origin from the socket
//   URL itself (`http(s)://host[:port]`, SocketRocket on iOS and WebSocketModule on Android).
// JSONP polling (`j` query parameter) is refused outright: a `<script src>` on another website sends no Origin and
// gets the session id back as script it can run, which would let that website drive a session. Our clients never
// use it. Engine.io answers every refused request with 400 (MIDDLEWARE_FAILURE).

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const JSONP_QUERY_PARAM = "j";

/** Host[:port] in canonical form (lowercase, default port for the origin's protocol dropped), or null if malformed. */
function canonicalHost(protocol: string, host: string): string | null {
  try {
    return new URL(`${protocol}//${host}`).host;
  } catch {
    return null;
  }
}

/** True when the request comes from a non-browser client (no Origin) or from the server's own host. */
export function isAllowedSocketOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (!WEB_PROTOCOLS.has(originUrl.protocol)) return false;
  const requestHost = canonicalHost(originUrl.protocol, host);
  return requestHost !== null && requestHost === originUrl.host;
}

/** True for engine.io's JSONP polling transport (`?j=<index>`), which a cross-origin `<script>` can read. */
export function isJsonpRequest(url: string | undefined): boolean {
  return new URL(url ?? "/", "http://localhost").searchParams.has(JSONP_QUERY_PARAM);
}

/** engine.io middleware (`io.engine.use`): runs on every socket.io HTTP request and upgrade, not just handshakes. */
export function socketOriginGuard(req: IncomingMessage, _res: ServerResponse, next: (err?: Error) => void) {
  if (isJsonpRequest(req.url)) return next(new Error("JSONP polling is disabled"));
  if (!isAllowedSocketOrigin(req.headers.origin, req.headers.host)) return next(new Error("Origin not allowed"));
  next();
}
