import type { IncomingMessage } from "http";
import { isIPv6 } from "net";
import { envInt, parseTrustProxy } from "../middlewares/rateLimit";

// Abuse limits for socket events that are not tied to a room member (connections, join attempts with a code)
// and per-socket limits for social events. All in memory, like the rooms.

// ── Client IP ──

/** Reverse-proxy hops whose X-Forwarded-For is trusted: the same setting app.ts gives Express ("trust proxy"). */
export const TRUST_PROXY_HOPS = parseTrustProxy(process.env.TRUST_PROXY, Boolean(process.env.RENDER));

/**
 * Client IP of a socket.io handshake, as Express computes req.ip with `trust proxy` = `hops`: the remote address
 * when no proxy is trusted, else the X-Forwarded-For entry `hops` places left of it (a client-supplied
 * X-Forwarded-For can't override what the trusted proxies appended).
 */
export function handshakeIp(req: Pick<IncomingMessage, "headers" | "socket">, hops = TRUST_PROXY_HOPS): string {
  const remote = req.socket?.remoteAddress || "unknown";
  if (hops <= 0) return remote;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  // Nearest first: the remote peer (first trusted proxy), then X-Forwarded-For right to left
  const chain = [remote, ...raw.split(",").map((s) => s.trim()).filter(Boolean).reverse()];
  return chain[Math.min(hops, chain.length - 1)];
}

/** Full 8-group form of an IPv6 address (no zone id), or null if it isn't one. */
function expandIPv6(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  let addr = ip;
  // Trailing embedded IPv4 (e.g. ::1.2.3.4) → two hex groups
  const v4 = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.slice(0, -v4[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/**
 * Key that per-IP limits count by: IPv4-mapped IPv6 (::ffff:a.b.c.d) as plain IPv4, and IPv6 by its /64 prefix
 * (one subscriber usually gets a whole /64, so per-address limits would be trivial to rotate around).
 */
export function ipKey(ip: string): string {
  let addr = ip.trim();
  const bracketed = addr.match(/^\[([^\]]+)\](?::\d+)?$/); // [v6]:port
  if (bracketed) addr = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr)) addr = addr.slice(0, addr.lastIndexOf(":")); // v4:port
  addr = addr.split("%")[0];
  const groups = expandIPv6(addr);
  if (!groups) return addr;
  // IPv4-mapped (::ffff:a.b.c.d, in any notation) → dotted IPv4
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    const [hi, lo] = [parseInt(groups[6], 16), parseInt(groups[7], 16)];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Per-IP limit key of a socket.io / engine.io handshake request. */
export const handshakeKey = (req: Pick<IncomingMessage, "headers" | "socket">): string => ipKey(handshakeIp(req));

// ── Concurrent connections per IP ──

/**
 * Per-IP cap on open sockets. A party often shares one public IP (Wi-Fi, carrier NAT), and a reconnect may overlap
 * its stale socket for a few seconds, so the default leaves room for several full rooms (12 players) per IP.
 */
export const MAX_CONNECTIONS_PER_IP = envInt("SOCKET_MAX_CONNECTIONS_PER_IP", 100, 1, 100_000);

/**
 * Open connections per IP key. Counted at the engine.io level (every transport connection, whose "close" always
 * fires, even when the socket.io handshake never completes), so the count can't leak; `over` tells whether an IP is
 * past the cap with its current connection included.
 */
export function createConnectionCounter(max: number) {
  const open = new Map<string, number>();
  return {
    acquire(ip: string): void {
      open.set(ip, (open.get(ip) ?? 0) + 1);
    },
    release(ip: string): void {
      const n = (open.get(ip) ?? 0) - 1;
      if (n > 0) open.set(ip, n);
      else open.delete(ip);
    },
    over: (ip: string) => (open.get(ip) ?? 0) > max,
    count: (ip: string) => open.get(ip) ?? 0,
    tracked: () => open.size,
  };
}

// ── Join attempts with an unknown room code, per IP ──

/**
 * join-create-game with a code that matches no room counts against the sender's IP: at most JOIN_MISS_MAX in any
 * JOIN_MISS_WINDOW_MS (default 30/min). Over it, joins with a code from that IP get "Too many attempts" whether the
 * code exists or not, except a rejoin with a valid rejoinToken (a reconnecting player never gets locked out) and a
 * join to a room that already has a connected player on the same IP (that network knows the code anyway, so one
 * device on a party Wi-Fi can't lock the others out). A socket records at most one miss per
 * JOIN_MISS_SOCKET_INTERVAL_MS, so a single socket can't fill the window by itself.
 * Guessing 6-digit codes from one IP is then far too slow to find rooms; legit typos stay well under it.
 */
export const JOIN_MISS_MAX = envInt("JOIN_MISS_MAX", 30, 1, 100_000);
export const JOIN_MISS_WINDOW_MS = envInt("JOIN_MISS_WINDOW_MS", 60_000, 1_000, 3_600_000);
export const JOIN_MISS_SOCKET_INTERVAL_MS = 3_000;
/**
 * While locked, misses keep counting up to JOIN_MISS_HARD_FACTOR × JOIN_MISS_MAX; past that only token rejoins get
 * through (no same-network exemption). Same-network exempted joins are capped at JOIN_EXEMPT_MAX per IP per window.
 */
export const JOIN_MISS_HARD_FACTOR = 3;
export const JOIN_EXEMPT_MAX = envInt("JOIN_EXEMPT_MAX", 24, 1, 100_000);

// ── Token bucket (per socket) ──

/** Token bucket of `burst` refilled at `ratePerS`: take() is false (and takes nothing) when empty. */
export function createTokenBucket(burst: number, ratePerS: number, now: () => number = Date.now) {
  let tokens = burst;
  let at = now();
  return {
    take(): boolean {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * ratePerS);
      at = t;
      if (tokens < 1) return false;
      tokens--;
      return true;
    },
  };
}

// ── Emoji reactions ──

/**
 * The only emoji-reaction values the server relays: the app's emoji picker
 * (Client/app/components/IngameComunication/EmojisButtons.tsx) plus "📸", sent when a player takes a screenshot.
 */
export const ALLOWED_EMOJIS: ReadonlySet<string> = new Set(["😂", "😍", "❓", "😳", "🔥", "😭", "🤡", "😡", "📸"]);
// The app sends at most one every 250 ms; a short burst of taps is fine, a flood is dropped silently
export const EMOJI_BURST = 5;
export const EMOJI_RATE_PER_S = 4;

// ── Hold ──

// hold-start per socket (hold-end is never limited, so a release always gets through). The engine also caps holds
// per round (GameEngine MAX_HOLDS_PER_ROUND / HOLD_BUDGET_PER_ROUND).
export const HOLD_START_BURST = 3;
export const HOLD_START_RATE_PER_S = 0.5;
