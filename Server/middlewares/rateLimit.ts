import { NextFunction, Request, Response } from "express";

/**
 * In-memory sliding-window rate limit keyed by client IP (req.ip; see "trust proxy" in app.ts).
 * At most `max` requests per IP in any `windowMs`; extra requests get 429 and are not counted.
 */
export function createRateLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();

  // Drop idle IPs so the map does not grow without bound
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits) {
      if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(ip);
    }
  }, windowMs);
  sweep.unref();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const times = hits.get(ip) ?? [];
    while (times.length && now - times[0] >= windowMs) times.shift();
    if (times.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil((windowMs - (now - times[0])) / 1000)));
      res.status(429).json({ error: "Too many uploads" });
      return;
    }
    times.push(now);
    hits.set(ip, times);
    next();
  };
  /** Number of IPs currently tracked (for tests). */
  middleware.trackedIps = () => hits.size;
  return middleware;
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
// Generous because a whole party often shares one Wi-Fi (one public IP): ~1 upload per round per room
// plus one planted photo per player. Overridable for load tests (qa/lab/lab.sh server raises the max).
export const UPLOAD_RATE_MAX = envInt("UPLOAD_RATE_MAX", 60, 1, 100_000);
export const UPLOAD_RATE_WINDOW_MS = envInt("UPLOAD_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000);

export const uploadRateLimit = createRateLimiter({ max: UPLOAD_RATE_MAX, windowMs: UPLOAD_RATE_WINDOW_MS });
