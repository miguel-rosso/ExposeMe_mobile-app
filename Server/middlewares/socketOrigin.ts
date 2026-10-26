import type { IncomingMessage, ServerResponse } from "http";
import { createSlidingWindow, envInt } from "./rateLimit";
import { handshakeKey } from "../managers/socketGuards";

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
// Optional host allowlist (env ALLOWED_HOSTS): when set, the request's Host must be one of those names too, so another
// domain pointed at the server's IP (DNS rebinding) can't pass the same-host check with its own name. Unset: any Host.

const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const JSONP_QUERY_PARAM = "j";
/** engine.io session id: present on every request of an open session, absent on the handshake that creates one. */
const SESSION_QUERY_PARAM = "sid";

/** Host[:port] in canonical form (lowercase, default port for the origin's protocol dropped), or null if malformed. */
function canonicalHost(protocol: string, host: string): string | null {
  try {
    return new URL(`${protocol}//${host}`).host;
  } catch {
    return null;
  }
}

/**
 * Hostname of a Host header or allowlist entry (lowercase, IDN in punycode, port dropped), or null unless it is a
 * bare host[:port] (no scheme, credentials or path).
 */
function hostnameOf(host: string): string | null {
  try {
    const url = new URL(`http://${host}`);
    const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    return bare && !host.includes("/") ? url.hostname || null : null;
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

/**
 * Hostnames of a comma-separated ALLOWED_HOSTS value ("exposeme.onrender.com, play.example:8443"; ports are ignored),
 * or null when it names none: then every Host is accepted. Malformed entries are skipped with a warning.
 */
export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> | null {
  const hosts = new Set<string>();
  for (const entry of (raw ?? "").split(",").map((h) => h.trim()).filter(Boolean)) {
    const hostname = hostnameOf(entry);
    if (hostname) hosts.add(hostname);
    else console.warn(`[config] ignoring ALLOWED_HOSTS entry ${JSON.stringify(entry)} (not a host name)`);
  }
  return hosts.size ? hosts : null;
}

/** True when there is no allowlist, or the request's Host header names one of its hosts (any port). */
export function isAllowedHost(host: string | undefined, allowedHosts: ReadonlySet<string> | null): boolean {
  if (!allowedHosts) return true;
  const hostname = host ? hostnameOf(host) : null;
  return hostname !== null && allowedHosts.has(hostname);
}

const searchParams = (url: string | undefined) => new URL(url ?? "/", "http://localhost").searchParams;

/** True for engine.io's JSONP polling transport (`?j=<index>`), which a cross-origin `<script>` can read. */
export function isJsonpRequest(url: string | undefined): boolean {
  return searchParams(url).has(JSONP_QUERY_PARAM);
}

/**
 * True for a request that opens a new engine.io session (polling or WebSocket handshake). Same rule as engine.io:
 * the last `sid` parameter wins and an empty one (`&sid=`, `&sid`) means "no session yet".
 */
export function isHandshakeRequest(url: string | undefined): boolean {
  return !Object.fromEntries(searchParams(url))[SESSION_QUERY_PARAM];
}

type EngineMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: Error) => void) => void;

/** engine.io middleware (`io.engine.use`): runs on every socket.io HTTP request and upgrade, not just handshakes. */
export function createSocketOriginGuard(allowedHosts: ReadonlySet<string> | null): EngineMiddleware {
  return (req, _res, next) => {
    if (isJsonpRequest(req.url)) return next(new Error("JSONP polling is disabled"));
    if (!isAllowedHost(req.headers.host, allowedHosts)) return next(new Error("Host not allowed"));
    if (!isAllowedSocketOrigin(req.headers.origin, req.headers.host)) return next(new Error("Origin not allowed"));
    next();
  };
}

export const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);
export const socketOriginGuard = createSocketOriginGuard(ALLOWED_HOSTS);

// ── New engine.io sessions per IP ──
// Every handshake creates a session that lives until socket.io's connect timeout even if no socket ever joins (a
// browser can start one with a plain `<img>` or `<script>` tag, which sends no Origin), and the per-IP cap on open
// connections (managers/socketGuards) only refuses the socket.io CONNECT, not the session. So each IP may open at most
// SOCKET_HANDSHAKE_RATE_MAX sessions per minute; requests of an open session (polling, upgrade) don't count. The
// default leaves ample room for a full party on one IP reconnecting through a flaky network.

export const SOCKET_HANDSHAKE_RATE_MAX = envInt("SOCKET_HANDSHAKE_RATE_MAX", 300, 1, 1_000_000);
export const SOCKET_HANDSHAKE_WINDOW_MS = 60_000;

/** engine.io middleware: refuses a handshake from an IP that already opened `max` sessions in the last `windowMs`. */
export function createHandshakeLimit({ max, windowMs }: { max: number; windowMs: number }) {
  const window = createSlidingWindow({ max, windowMs });
  const middleware: EngineMiddleware = (req, _res, next) => {
    if (!isHandshakeRequest(req.url)) return next();
    const ip = handshakeKey(req);
    if (window.retryAfter(ip)) return next(new Error("Too many handshakes"));
    window.hit(ip);
    next();
  };
  /** IP keys currently tracked (for tests). */
  return Object.assign(middleware, { trackedIps: window.tracked });
}

export const socketHandshakeLimit = createHandshakeLimit({ max: SOCKET_HANDSHAKE_RATE_MAX, windowMs: SOCKET_HANDSHAKE_WINDOW_MS });
