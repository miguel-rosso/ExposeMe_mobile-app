import { NextFunction, Request, Response } from "express";
import { ipKey } from "./ipKey";

/**
 * Per-IP limit key of an HTTP request: req.ip (see "trust proxy" in app.ts) normalized by ipKey, so IPv6 counts by
 * its /64 and IPv4-mapped IPv6 as plain IPv4, the same key the socket.io handshake limits use.
 */
export const clientIp = (req: Request) => ipKey(req.ip || req.socket.remoteAddress || "unknown");

/** In-memory sliding window: at most `max` hits per key in any `windowMs`. */
export function createSlidingWindow({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();

  // Drop idle keys so the map does not grow without bound
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  /** Seconds until `key` may hit again, or 0 if it is under the limit now. */
  const retryAfter = (key: string): number => {
    const now = Date.now();
    const times = hits.get(key);
    if (!times) return 0;
    while (times.length && now - times[0] >= windowMs) times.shift();
    return times.length >= max ? Math.ceil((windowMs - (now - times[0])) / 1000) : 0;
  };
  const hit = (key: string) => {
    const times = hits.get(key) ?? [];
    times.push(Date.now());
    hits.set(key, times);
  };
  return { retryAfter, hit, tracked: () => hits.size };
}

function tooMany(res: Response, retryAfterS: number) {
  res.setHeader("Retry-After", String(retryAfterS));
  res.status(429).json({ error: "Too many uploads" });
}

/**
 * Sliding-window rate limit middleware keyed by client IP (clientIp: normalized req.ip), or by `key`.
 * At most `max` requests per key in any `windowMs`; extra requests get 429 and are not counted.
 * Requests for which `appliesTo` is false pass through without being limited or counted.
 */
export function createRateLimiter({
  max,
  windowMs,
  key = clientIp,
  appliesTo,
}: {
  max: number;
  windowMs: number;
  key?: (req: Request, res: Response) => string;
  appliesTo?: (req: Request, res: Response) => boolean;
}) {
  const window = createSlidingWindow({ max, windowMs });
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (appliesTo && !appliesTo(req, res)) return next();
    const k = key(req, res);
    const wait = window.retryAfter(k);
    if (wait) return tooMany(res, wait);
    window.hit(k);
    next();
  };
  /** Number of keys currently tracked (for tests). */
  middleware.trackedIps = window.tracked;
  return middleware;
}

/**
 * Per-IP limit on *rejected* requests only (missing or wrong credentials): every rejection counts, and once an IP has
 * had `max` in the window its missing/malformed ones (401) get 429 instead. Well-formed but wrong credentials always
 * get 403, so a client whose session expired re-joins instead of waiting out a Retry-After. A 429 there would not
 * slow a token guesser: credentials are checked before this limiter (a member on a throttled IP still gets in), so a
 * hit is told apart either way, and rejoin tokens are 144 random bits. Authenticated members never touch it, so other
 * devices on the same Wi-Fi (one public IP at a party) can neither block nor observe a room's uploads through it.
 */
export function createRejectionLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const window = createSlidingWindow({ max, windowMs });
  return {
    reject(req: Request, res: Response, status: 401 | 403) {
      const ip = clientIp(req);
      const wait = window.retryAfter(ip);
      if (wait && status === 401) return tooMany(res, wait);
      // Requests over the limit are not counted (as in createRateLimiter)
      if (!wait) window.hit(ip);
      res.status(status).json({ error: status === 401 ? "Unauthorized" : "Forbidden" });
    },
    trackedIps: window.tracked,
  };
}

/** Integer env var clamped to [min, max]; `fallback` when unset or not an integer. */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.warn(`[config] ignoring ${name}=${raw} (not an integer)`);
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

/**
 * TRUST_PROXY → number of reverse-proxy hops whose X-Forwarded-For is trusted (0 = off). Only an integer
 * (or "false") is accepted: "true" would trust a client-supplied X-Forwarded-For, anything else is logged
 * and ignored. Unset → 1 on Render, 0 elsewhere.
 */
export function parseTrustProxy(raw: string | undefined, onRender: boolean): number {
  const value = raw?.trim().toLowerCase();
  if (!value) return onRender ? 1 : 0;
  if (value === "false") return 0;
  if (/^\d{1,2}$/.test(value)) return Number(value);
  console.warn(`[config] ignoring TRUST_PROXY=${raw} (expected a hop count)`);
  return onRender ? 1 : 0;
}

// ── POST /upload limits ──
// Credentials are checked first, and only rejected requests are counted per IP (a whole party often shares one
// public IP). Members are limited per member and per room, never by IP: neither a stranger on the Wi-Fi nor a
// member who hit their own limit can make another member's upload fail. ~1 upload per round per room plus a few
// lobby re-picks per player is far below these. Overridable for load tests (qa/lab/lab.sh server raises them).
// The member limit counts per seat (player object), not per name, so a newcomer never inherits the quota a departed
// player spent under the same name. The room limit only counts once the game has started: in the lobby anyone can
// leave and rejoin under a new name with a fresh member quota, so a room budget there could be drained by one person.
export const UPLOAD_RATE_WINDOW_MS = envInt("UPLOAD_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000);
export const UPLOAD_REJECTED_MAX = envInt("UPLOAD_REJECTED_MAX", 30, 1, 100_000);
export const UPLOAD_PLAYER_RATE_MAX = envInt("UPLOAD_PLAYER_RATE_MAX", 20, 1, 100_000);
/** Defaults to a full room (12 players) at the member limit, so one member can never use it up. */
export const UPLOAD_ROOM_RATE_MAX = envInt("UPLOAD_ROOM_RATE_MAX", 12 * UPLOAD_PLAYER_RATE_MAX, 1, 1_000_000);

/** What the upload limits read from res.locals.member (set by requireUploadMember). */
export interface UploadMemberLocals { room: { gameCode: string; started: boolean }; player: object }
const member = (res: Response) => res.locals.member as UploadMemberLocals;

/** Id of a player's seat: the same across rejoins (same Player object), a new one for every new join. */
const seatIds = new WeakMap<object, number>();
let lastSeatId = 0;
function seatId(player: object): number {
  let id = seatIds.get(player);
  if (id === undefined) seatIds.set(player, (id = ++lastSeatId));
  return id;
}

/**
 * Key of a member for every per-member upload limit: their seat in the room, not their name, so someone joining
 * under a departed player's name never inherits what that player used up.
 */
export const memberKey = ({ room, player }: UploadMemberLocals) => `${room.gameCode}\n${seatId(player)}`;

export const uploadRejectionLimit = createRejectionLimiter({ max: UPLOAD_REJECTED_MAX, windowMs: UPLOAD_RATE_WINDOW_MS });

export const uploadPlayerRateLimit = createRateLimiter({
  max: UPLOAD_PLAYER_RATE_MAX,
  windowMs: UPLOAD_RATE_WINDOW_MS,
  key: (_req, res) => memberKey(member(res)),
});

export const uploadRoomRateLimit = createRateLimiter({
  max: UPLOAD_ROOM_RATE_MAX,
  windowMs: UPLOAD_RATE_WINDOW_MS,
  key: (_req, res) => member(res).room.gameCode,
  appliesTo: (_req, res) => member(res).room.started,
});
