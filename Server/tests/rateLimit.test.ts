import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, createRejectionLimiter, envInt, parseTrustProxy } from "../middlewares/rateLimit";

function call(limiter: ReturnType<typeof createRateLimiter>, ip: string) {
  const res = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const fake = {
    setHeader: (k: string, v: string) => { res.headers[k] = v; },
    status: (code: number) => { res.statusCode = code; return fake; },
    json: (body: unknown) => { res.body = body; return fake; },
  };
  const next = vi.fn();
  limiter({ ip, socket: {} } as unknown as Request, fake as unknown as Response, next);
  return { ...res, passed: next.mock.calls.length === 1 };
}

describe("createRateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers 429 with Retry-After once an IP fills the window, other IPs unaffected", () => {
    const limiter = createRateLimiter({ max: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i++) expect(call(limiter, "1.1.1.1").passed).toBe(true);
    vi.advanceTimersByTime(4_000);
    const limited = call(limiter, "1.1.1.1");
    expect(limited.passed).toBe(false);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["Retry-After"]).toBe("6");
    expect(call(limiter, "2.2.2.2").passed).toBe(true);
  });

  it("lets requests through again when the window slides past the old ones", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 10_000 });
    call(limiter, "1.1.1.1");
    vi.advanceTimersByTime(5_000);
    call(limiter, "1.1.1.1");
    expect(call(limiter, "1.1.1.1").passed).toBe(false);
    vi.advanceTimersByTime(5_000); // first hit expires
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
    expect(call(limiter, "1.1.1.1").passed).toBe(false);
  });

  it("rejected requests do not extend the block", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000 });
    call(limiter, "1.1.1.1");
    for (let i = 0; i < 9; i++) { vi.advanceTimersByTime(1_000); expect(call(limiter, "1.1.1.1").passed).toBe(false); }
    vi.advanceTimersByTime(1_000);
    expect(call(limiter, "1.1.1.1").passed).toBe(true);
  });

  it("the periodic sweep forgets idle IPs", () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 10_000 });
    call(limiter, "1.1.1.1");
    call(limiter, "2.2.2.2");
    expect(limiter.trackedIps()).toBe(2);
    vi.advanceTimersByTime(9_000);
    call(limiter, "2.2.2.2"); // still active
    vi.advanceTimersByTime(1_000); // sweep at 10s: 1.1.1.1 idle for 10s
    expect(limiter.trackedIps()).toBe(1);
    vi.advanceTimersByTime(10_000); // sweep at 20s: 2.2.2.2 idle for 11s
    expect(limiter.trackedIps()).toBe(0);
  });
});

// EXP-154: a client whose session expired must be told to re-authenticate (403), not to wait (429)
describe("createRejectionLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function reject(limiter: ReturnType<typeof createRejectionLimiter>, status: 401 | 403) {
    const res = { statusCode: 0, headers: {} as Record<string, string> };
    const fake = {
      setHeader: (k: string, v: string) => { res.headers[k] = v; },
      status: (code: number) => { res.statusCode = code; return fake; },
      json: () => fake,
    };
    limiter.reject({ ip: "1.1.1.1", socket: {} } as unknown as Request, fake as unknown as Response, status);
    return res;
  }

  it("once an IP is over the limit, malformed credentials get 429 but well-formed wrong ones still get 403", () => {
    const limiter = createRejectionLimiter({ max: 2, windowMs: 10_000 });
    expect(reject(limiter, 403).statusCode).toBe(403);
    expect(reject(limiter, 401).statusCode).toBe(401);
    const throttled = reject(limiter, 401);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["Retry-After"]).toBe("10");
    const expired = reject(limiter, 403);
    expect(expired.statusCode).toBe(403);
    expect(expired.headers["Retry-After"]).toBeUndefined();
  });

  it("rejections over the limit don't extend the block", () => {
    const limiter = createRejectionLimiter({ max: 1, windowMs: 10_000 });
    reject(limiter, 403);
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(1_000);
      expect(reject(limiter, 403).statusCode).toBe(403);
      expect(reject(limiter, 401).statusCode).toBe(429);
    }
    vi.advanceTimersByTime(1_000);
    expect(reject(limiter, 401).statusCode).toBe(401);
  });
});

describe("config parsing", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("envInt clamps and ignores non-integers", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(envInt("X_TEST_INT", 60, 1, 100)).toBe(60);
    vi.stubEnv("X_TEST_INT", "500");
    expect(envInt("X_TEST_INT", 60, 1, 100)).toBe(100);
    vi.stubEnv("X_TEST_INT", "0");
    expect(envInt("X_TEST_INT", 60, 1, 100)).toBe(1);
    vi.stubEnv("X_TEST_INT", "lots");
    expect(envInt("X_TEST_INT", 60, 1, 100)).toBe(60);
  });

  it("parseTrustProxy accepts only a hop count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTrustProxy(undefined, false)).toBe(0);
    expect(parseTrustProxy(undefined, true)).toBe(1);
    expect(parseTrustProxy("2", true)).toBe(2);
    expect(parseTrustProxy("0", true)).toBe(0);
    expect(parseTrustProxy("false", true)).toBe(0);
    expect(parseTrustProxy("true", false)).toBe(0); // would trust a spoofed X-Forwarded-For
    expect(parseTrustProxy("loopback", true)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
