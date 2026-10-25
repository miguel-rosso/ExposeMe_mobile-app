import { NextFunction, Request, Response } from "express";

export const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || "unknown";

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
 * Sliding-window rate limit middleware keyed by client IP (req.ip; see "trust proxy" in app.ts), or by `key`.
 * At most `max` requests per key in any `windowMs`; extra requests get 429 and are not counted.
 */
export function createRateLimiter({
  max,
  windowMs,
  key = clientIp,
}: {
  max: number;
  windowMs: number;
  key?: (req: Request, res: Response) => string;
}) {
  const window = createSlidingWindow({ max, windowMs });
  const middleware = (req: Request, res: Response, next: NextFunction) => {
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
 * Per-IP limit on *rejected* requests only (missing or wrong credentials): `reject` answers 429 instead of 401/403
 * once an IP has had `max` rejections in the window. Authenticated members never touch it, so other devices on the
 * same Wi-Fi (one public IP at a party) can neither block nor observe a room's uploads through it.
 */
export function createRejectionLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const window = createSlidingWindow({ max, windowMs });
  return {
    reject(req: Request, res: Response, status: 401 | 403) {
      const ip = clientIp(req);
      const wait = window.retryAfter(ip);
      if (wait) return tooMany(res, wait);
      window.hit(ip);
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
export const UPLOAD_RATE_WINDOW_MS = envInt("UPLOAD_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000);
export const UPLOAD_REJECTED_MAX = envInt("UPLOAD_REJECTED_MAX", 30, 1, 100_000);
export const UPLOAD_PLAYER_RATE_MAX = envInt("UPLOAD_PLAYER_RATE_MAX", 20, 1, 100_000);
/** Defaults to a full room (12 players) at the member limit, so one member can never use it up. */
export const UPLOAD_ROOM_RATE_MAX = envInt("UPLOAD_ROOM_RATE_MAX", 12 * UPLOAD_PLAYER_RATE_MAX, 1, 1_000_000);

interface MemberLocals { room: { gameCode: string }; player: { username: string } }
const member = (res: Response) => res.locals.member as MemberLocals;

export const uploadRejectionLimit = createRejectionLimiter({ max: UPLOAD_REJECTED_MAX, windowMs: UPLOAD_RATE_WINDOW_MS });

export const uploadPlayerRateLimit = createRateLimiter({
  max: UPLOAD_PLAYER_RATE_MAX,
  windowMs: UPLOAD_RATE_WINDOW_MS,
  key: (_req, res) => `${member(res).room.gameCode}\n${member(res).player.username}`,
});

export const uploadRoomRateLimit = createRateLimiter({
  max: UPLOAD_ROOM_RATE_MAX,
  windowMs: UPLOAD_RATE_WINDOW_MS,
  key: (_req, res) => member(res).room.gameCode,
});
