import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, createRateLimiter, createRejectionLimiter } from "../middlewares/rateLimit";
import { createInFlightLimiter } from "../middlewares/uploadInFlight";
import { ipKey as guardsIpKey } from "../managers/socketGuards";
import { ipKey } from "../middlewares/ipKey";

// EXP-181: every Express per-IP limit keys by the same normalized IP as the socket.io handshake limits: IPv6 by its
// /64 (rotating addresses inside it doesn't buy a fresh bucket) and IPv4-mapped IPv6 as plain IPv4.

/** A request whose body was already received: the in-flight limiter only listens to it. */
const req = (ip: string) =>
  Object.assign(new EventEmitter(), { ip, socket: {}, complete: true, pause() {}, resume() {} }) as unknown as Request;

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    writableFinished: false,
    locals: {} as Record<string, unknown>,
    setHeader(k: string, v: string) { res.headers[k] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  });
  return res;
}

describe("clientIp", () => {
  it("normalizes req.ip with the shared ipKey", () => {
    expect(clientIp(req("2001:db8:1:2::1"))).toBe("2001:db8:1:2::/64");
    expect(clientIp(req("2001:db8:1:2:aaaa:bbbb:cccc:dddd"))).toBe("2001:db8:1:2::/64");
    expect(clientIp(req("2001:db8:1:3::1"))).toBe("2001:db8:1:3::/64");
    expect(clientIp(req("::ffff:203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp(req("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIp({ socket: { remoteAddress: "::ffff:10.0.0.1" } } as unknown as Request)).toBe("10.0.0.1");
    expect(clientIp({ socket: {} } as unknown as Request)).toBe("unknown");
  });

  it("socketGuards re-exports the same ipKey", () => {
    expect(guardsIpKey).toBe(ipKey);
  });
});

describe("createRateLimiter keyed by client IP", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hit = (limiter: ReturnType<typeof createRateLimiter>, ip: string) => {
    const res = fakeRes();
    const next = vi.fn();
    limiter(req(ip), res as unknown as Response, next);
    return next.mock.calls.length === 1 ? 200 : res.statusCode;
  };

  it("rotating addresses inside one /64 shares a bucket; another /64 does not", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 10_000 });
    expect(hit(limiter, "2001:db8:1:2::1")).toBe(200);
    expect(hit(limiter, "2001:db8:1:2::2")).toBe(200);
    expect(hit(limiter, "2001:db8:1:2:ffff::3")).toBe(429);
    expect(hit(limiter, "2001:db8:1:3::1")).toBe(200);
    expect(limiter.trackedIps()).toBe(2);
  });

  it("IPv4-mapped IPv6 and plain IPv4 share a bucket", () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000 });
    expect(hit(limiter, "::ffff:203.0.113.7")).toBe(200);
    expect(hit(limiter, "203.0.113.7")).toBe(429);
    expect(hit(limiter, "203.0.113.8")).toBe(200);
  });
});

describe("upload rejection limiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const reject = (limiter: ReturnType<typeof createRejectionLimiter>, ip: string) => {
    const res = fakeRes();
    limiter.reject(req(ip), res as unknown as Response, 401);
    return res.statusCode;
  };

  it("counts rejections per /64, so rotating inside it hits the same limit", () => {
    const limiter = createRejectionLimiter({ max: 3, windowMs: 10_000 });
    for (let i = 1; i <= 3; i++) expect(reject(limiter, `2001:db8:1:2::${i}`)).toBe(401);
    expect(reject(limiter, "2001:db8:1:2:dead:beef:0:1")).toBe(429);
    expect(reject(limiter, "2001:db8:9:9::1")).toBe(401);
    expect(limiter.trackedIps()).toBe(2);
  });

  it("IPv4-mapped and plain IPv4 share the rejection count", () => {
    const limiter = createRejectionLimiter({ max: 1, windowMs: 10_000 });
    expect(reject(limiter, "::ffff:198.51.100.4")).toBe(401);
    expect(reject(limiter, "198.51.100.4")).toBe(429);
  });
});

describe("upload in-flight per-IP cap", () => {
  const limiter = () => createInFlightLimiter({ max: 100, perIpMax: 2, perRoomMax: 100, perMemberMax: 100, timeoutMs: 60_000 });

  let n = 0;
  const start = (mw: ReturnType<typeof limiter>, ip: string) => {
    const res = fakeRes();
    res.locals.member = { room: { gameCode: `R${++n}` }, player: { username: `p${n}` } };
    const next = vi.fn();
    mw(req(ip), res as unknown as Response, next);
    return { status: next.mock.calls.length === 1 ? 200 : res.statusCode, body: res.body, res };
  };

  it("uploads from one /64 share the per-IP slots; another /64 has its own", () => {
    const mw = limiter();
    expect(start(mw, "2001:db8:1:2::1").status).toBe(200);
    const second = start(mw, "2001:db8:1:2::2");
    expect(second.status).toBe(200);
    const third = start(mw, "2001:db8:1:2:abcd::9");
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ scope: "ip" });
    expect(start(mw, "2001:db8:1:3::1").status).toBe(200);
    expect(mw.inFlight().ips).toBe(2);
    // Releasing a slot frees it for the whole /64
    second.res.emit("finish");
    expect(start(mw, "2001:db8:1:2::77").status).toBe(200);
  });

  it("IPv4-mapped and plain IPv4 share the per-IP slots", () => {
    const mw = limiter();
    expect(start(mw, "::ffff:192.0.2.1").status).toBe(200);
    expect(start(mw, "192.0.2.1").status).toBe(200);
    expect(start(mw, "::ffff:192.0.2.1").status).toBe(429);
    expect(mw.inFlight().ips).toBe(1);
  });
});

// EXP-188: IPv6 ranges that embed a whole IPv4 address in their low 32 bits key by that IPv4, like IPv4-mapped does,
// instead of lumping every embedded IPv4 into one /64.
describe("ipKey for IPv6 ranges with an embedded IPv4", () => {
  it("NAT64 well-known prefix (64:ff9b::/96) keys by the embedded IPv4", () => {
    expect(ipKey("64:ff9b::198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("64:ff9b::c633:6405")).toBe("198.51.100.5");
    expect(ipKey("0064:FF9B:0000:0000:0000:0000:c633:6405")).toBe("198.51.100.5");
    expect(ipKey("[64:ff9b::198.51.100.4]:443")).toBe("198.51.100.4");
    // Same key as the plain IPv4 and the IPv4-mapped form, for every per-IP limit
    expect(clientIp(req("64:ff9b::203.0.113.7"))).toBe(clientIp(req("::ffff:203.0.113.7")));
  });

  it("IPv4-compatible addresses (::a.b.c.d) key by the embedded IPv4", () => {
    expect(ipKey("::198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("::c633:6405")).toBe("198.51.100.5");
  });

  it("the unspecified and loopback addresses are not read as IPv4", () => {
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("::")).toBe("0:0:0:0::/64");
  });

  it("other addresses under those prefixes still group by /64", () => {
    // Local-use NAT64 (64:ff9b:1::/48) has no fixed IPv4 position
    expect(ipKey("64:ff9b:1::c633:6404")).toBe("64:ff9b:1:0::/64");
    expect(ipKey("64:ff9b:0:0:1::c633:6404")).toBe("64:ff9b:0:0::/64");
  });
});
