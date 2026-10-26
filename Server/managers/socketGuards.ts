import type { IncomingMessage } from "http";
import { ipKey } from "../middlewares/ipKey";
import { envInt, parseTrustProxy } from "../middlewares/rateLimit";

export { ipKey };

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
 * JOIN_MISS_SOCKET_INTERVAL_MS, and within that interval after a miss its joins with a code get "Too many attempts"
 * without looking the code up (same exemptions), so every "Game not found" is a recorded miss.
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
/**
 * Coarser layers on top of the per-key limit (an IPv6 key is a /64, and one subscriber or attacker often holds a
 * whole /48 = 65,536 /64s). They only ever tighten the limit of keys that have misses of their own: a key with no
 * misses in the window is never locked by what others did.
 * - every IPv6 miss also counts against its /48: while the /48 has JOIN_MISS_PREFIX_MAX misses in the window, each
 *   /64 in it is locked at JOIN_MISS_TIGHT_MAX own misses (hard ceiling: JOIN_MISS_HARD_FACTOR × both). IPv4 keys
 *   have no prefix layer.
 * - a global budget: once JOIN_MISS_GLOBAL_MAX misses (counted only from keys that were not locked) land in one
 *   window, the server is "under pressure" and every key's limit drops to JOIN_MISS_PRESSURE_MAX (and to
 *   JOIN_MISS_TIGHT_MAX in a /48 with 2 × JOIN_MISS_PRESSURE_MAX misses) until the window clears. An attacker can
 *   trigger it on purpose; it only affects keys with misses of their own (legit typos), and token rejoins /
 *   same-network joins keep their exemptions.
 */
export const JOIN_MISS_PREFIX_MAX = envInt("JOIN_MISS_PREFIX_MAX", 300, 1, 1_000_000);
export const JOIN_MISS_GLOBAL_MAX = envInt("JOIN_MISS_GLOBAL_MAX", 600, 1, 100_000_000);
export const JOIN_MISS_PRESSURE_MAX = envInt("JOIN_MISS_PRESSURE_MAX", 5, 1, 100_000);
export const JOIN_MISS_TIGHT_MAX = 2;
/** Keys (IPs and /48s) tracked at most; the least recently missing one is forgotten past it. */
export const JOIN_MISS_MAX_TRACKED = envInt("JOIN_MISS_MAX_TRACKED", 50_000, 100, 10_000_000);

/** "a:b:c::/48" for an IPv6 /64 key from ipKey ("a:b:c:d::/64"), else null (IPv4 and anything else). */
export function prefix48(key: string): string | null {
  if (!key.endsWith("::/64")) return null;
  const groups = key.slice(0, -"::/64".length).split(":");
  return groups.length === 4 ? `${groups.slice(0, 3).join(":")}::/48` : null;
}

/**
 * Recent timestamps per key in a sliding window of `windowMs`: at most `perKeyCap` per key (no recording past it)
 * and at most `maxKeys` keys (least recently hit dropped first), so rotating keys can't grow memory without bound.
 */
export function createMissLog({ windowMs, perKeyCap, maxKeys }: { windowMs: number; perKeyCap: number; maxKeys: number }) {
  const log = new Map<string, number[]>();
  const fresh = (key: string, now: number): number[] | undefined => {
    const times = log.get(key);
    if (!times) return undefined;
    while (times.length && now - times[0] >= windowMs) times.shift();
    if (!times.length) log.delete(key);
    return times.length ? times : undefined;
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const key of [...log.keys()]) fresh(key, now);
  }, windowMs);
  sweep.unref();
  return {
    count: (key: string): number => fresh(key, Date.now())?.length ?? 0,
    hit(key: string): void {
      const now = Date.now();
      const times = fresh(key, now) ?? [];
      if (times.length < perKeyCap) times.push(now);
      log.delete(key); // re-insert: Map order = least recently hit first
      log.set(key, times);
      while (log.size > maxKeys) log.delete(log.keys().next().value!);
    },
    tracked: () => log.size,
  };
}

const GLOBAL_KEY = "*";

/**
 * Join-miss bookkeeping for unknown room codes, keyed by ipKey: one miss log per key (soft lock, pressure limit and
 * hard ceiling are thresholds on its count), one per /48 and the global pressure budget described above.
 */
export function createJoinMissGuard(opts: {
  max: number; windowMs: number; hardFactor: number; prefixMax: number; globalMax: number; pressureMax: number;
  tightMax?: number; maxTracked?: number;
}) {
  const { max, windowMs, hardFactor, prefixMax, globalMax, pressureMax } = opts;
  const tightMax = opts.tightMax ?? JOIN_MISS_TIGHT_MAX;
  const maxKeys = opts.maxTracked ?? JOIN_MISS_MAX_TRACKED;
  const keys = createMissLog({ windowMs, perKeyCap: hardFactor * max, maxKeys });
  const prefixes = createMissLog({ windowMs, perKeyCap: hardFactor * prefixMax, maxKeys });
  const global = createMissLog({ windowMs, perKeyCap: globalMax, maxKeys: 1 });

  const underPressure = (): boolean => global.count(GLOBAL_KEY) >= globalMax;
  /** Joins with a code from this key answer "Too many attempts" (save the exemptions). Never for a key with no misses. */
  const locked = (key: string): boolean => {
    const own = keys.count(key);
    if (!own) return false;
    const p = prefix48(key);
    const inPrefix = p ? prefixes.count(p) : 0;
    let limit = max;
    if (p && inPrefix >= prefixMax) limit = Math.min(limit, tightMax);
    if (underPressure()) {
      limit = Math.min(limit, pressureMax);
      if (p && inPrefix >= 2 * pressureMax) limit = Math.min(limit, tightMax);
    }
    return own >= limit;
  };
  /** Past the hard ceiling: only token rejoins get through. Also needs misses of the key's own in a full /48. */
  const hardLocked = (key: string): boolean => {
    const own = keys.count(key);
    if (own >= hardFactor * max) return true;
    const p = prefix48(key);
    return !!p && prefixes.count(p) >= hardFactor * prefixMax && own >= hardFactor * tightMax;
  };
  const record = (key: string): void => {
    const wasLocked = locked(key);
    keys.hit(key);
    const p = prefix48(key);
    if (p) prefixes.hit(p);
    // Locked keys don't feed the global budget: one hammering key can't put the whole server under pressure
    if (!wasLocked) global.hit(GLOBAL_KEY);
  };
  /** Misses recorded for `key` in the window (capped at the hard ceiling). */
  const count = (key: string): number => keys.count(key);
  return { record, locked, hardLocked, underPressure, count, tracked: () => keys.tracked() + prefixes.tracked() };
}

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
