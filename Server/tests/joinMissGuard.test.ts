import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinMissGuard, createMissLog, ipKey, prefix48 } from "../managers/socketGuards";

// EXP-183: the join-miss limit is keyed per /64, so a /48 (65,536 /64s) could rotate around it. Coarser layers:
// per-/48 for IPv6 and a global budget, both only tightening the limit of keys that have misses of their own.

const WINDOW = 60_000;
const guardWith = (over: Partial<Parameters<typeof createJoinMissGuard>[0]> = {}) =>
  createJoinMissGuard({ max: 30, windowMs: WINDOW, hardFactor: 3, prefixMax: 300, globalMax: 600, pressureMax: 5, tightMax: 2, ...over });

/** /64 key number `i` inside the /48 2001:db8:aa::/48 */
const in48 = (i: number, prefix = "2001:db8:aa") => ipKey(`${prefix}:${i.toString(16)}::1`);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("prefix48", () => {
  it("maps IPv6 /64 keys to their /48 and leaves IPv4 alone", () => {
    expect(prefix48(ipKey("2001:db8:aa:1234::5"))).toBe("2001:db8:aa::/48");
    expect(prefix48(ipKey("2001:db8::1"))).toBe("2001:db8:0::/48");
    expect(prefix48(ipKey("10.0.0.1"))).toBeNull();
    expect(prefix48(ipKey("::ffff:10.0.0.1"))).toBeNull();
  });
});

describe("createMissLog", () => {
  it("caps timestamps per key and forgets the least recently hit key past maxKeys", () => {
    const log = createMissLog({ windowMs: WINDOW, perKeyCap: 3, maxKeys: 100 });
    for (let i = 0; i < 10; i++) log.hit("a");
    expect(log.count("a")).toBe(3);
    // Rotating 10,000 keys keeps at most 100 tracked; "a", hit again just now, survives
    for (let i = 0; i < 10_000; i++) {
      log.hit(`k${i}`);
      if (i % 50 === 0) log.hit("a");
    }
    expect(log.tracked()).toBeLessThanOrEqual(100);
    expect(log.count("a")).toBe(3);
    expect(log.count("k0")).toBe(0);
    vi.advanceTimersByTime(WINDOW);
    expect(log.count("a")).toBe(0);
  });

  it("the join guard's tracked keys stay under its cap while /64s and /48s rotate", () => {
    const g = guardWith({ maxTracked: 200 });
    for (let i = 0; i < 20_000; i++) g.record(ipKey(`2001:db8:${(i >> 4).toString(16)}:${(i & 15).toString(16)}::1`));
    expect(g.tracked()).toBeLessThanOrEqual(400); // 200 keys + 200 /48s
  });
});

describe("createJoinMissGuard (EXP-183)", () => {
  it("locks a key after max misses, hard-locks at hardFactor × max, and clears with the window", () => {
    const g = guardWith();
    const k = "10.0.0.1";
    for (let i = 0; i < 29; i++) g.record(k);
    expect(g.locked(k)).toBe(false);
    g.record(k);
    expect(g.locked(k)).toBe(true);
    expect(g.hardLocked(k)).toBe(false);
    for (let i = 0; i < 60; i++) g.record(k);
    expect(g.hardLocked(k)).toBe(true);
    expect(g.count(k)).toBe(90);
    vi.advanceTimersByTime(WINDOW);
    expect(g.locked(k)).toBe(false);
    expect(g.hardLocked(k)).toBe(false);
  });

  it("rotating /64s in a full /48 are locked at tightMax own misses; an innocent /64 with no misses is not", () => {
    const g = guardWith();
    // 300 misses spread over 150 /64s (2 each): each is far under its own limit (30) until the /48 fills
    for (let i = 0; i < 150; i++) {
      g.record(in48(i));
      if (i < 149) expect(g.locked(in48(i))).toBe(false);
      g.record(in48(i));
    }
    // The /48 is full: every rotating /64 (2 own misses) is locked...
    expect(g.locked(in48(0))).toBe(true);
    expect(g.locked(in48(149))).toBe(true);
    // ...a fresh /64 gets at most tightMax answered guesses
    const next = in48(1000);
    expect(g.locked(next)).toBe(false);
    g.record(next);
    expect(g.locked(next)).toBe(false);
    g.record(next);
    expect(g.locked(next)).toBe(true);
    // ...and a /64 with no misses of its own is never locked
    expect(g.locked(in48(5000))).toBe(false);
    expect(g.hardLocked(in48(5000))).toBe(false);
    vi.advanceTimersByTime(WINDOW);
    expect(g.locked(in48(0))).toBe(false);
  });

  it("the /48 hard ceiling only drops the same-network exemption of /64s with their own misses", () => {
    const g = guardWith({ prefixMax: 10 });
    for (let i = 0; i < 30; i++) g.record(in48(i)); // 30 = 3 × prefixMax in the /48, 1 miss per /64
    expect(g.hardLocked(in48(0))).toBe(false); // 1 own miss < 3 × tightMax
    for (let i = 0; i < 6; i++) g.record(in48(0));
    expect(g.hardLocked(in48(0))).toBe(true);
    expect(g.hardLocked(in48(5000))).toBe(false);
    expect(g.hardLocked(in48(1))).toBe(false);
  });

  it("distinct /48s don't share the prefix limit", () => {
    const g = guardWith({ prefixMax: 10 });
    for (let i = 0; i < 10; i++) g.record(in48(i, "2001:db8:aa"));
    const a = in48(999, "2001:db8:aa"), b = in48(999, "2001:db8:ab");
    for (const k of [a, b]) g.record(k), g.record(k);
    expect(g.locked(a)).toBe(true);
    expect(g.locked(b)).toBe(false);
  });

  it("IPv4 keys have no prefix layer: many addresses of one /24 each keep their own limit", () => {
    const g = guardWith({ prefixMax: 1 });
    for (let i = 1; i <= 100; i++) g.record(`10.0.0.${i}`), g.record(`10.0.0.${i}`);
    expect(g.locked("10.0.0.1")).toBe(false);
    expect(g.underPressure()).toBe(false);
  });

  it("past the global budget every key with misses drops to pressureMax until the window clears", () => {
    const g = guardWith({ globalMax: 100 });
    // 10 distinct IPv4 keys with 6 misses each: all under the per-key limit (30)...
    for (let i = 0; i < 10; i++) for (let j = 0; j < 6; j++) g.record(`10.0.1.${i}`);
    expect(g.underPressure()).toBe(false);
    expect(g.locked("10.0.1.0")).toBe(false);
    // ...then more keys push the global count to its budget
    for (let i = 0; i < 40; i++) g.record(`10.0.2.${i}`);
    expect(g.underPressure()).toBe(true);
    // Keys over pressureMax (5) are locked, keys under it (typos) and keys without misses are not
    expect(g.locked("10.0.1.0")).toBe(true);
    expect(g.locked("10.0.2.0")).toBe(false);
    expect(g.locked("192.168.1.1")).toBe(false);
    // Pressure doesn't touch the hard ceiling (same-network exemption keeps working)
    expect(g.hardLocked("10.0.1.0")).toBe(false);
    vi.advanceTimersByTime(WINDOW);
    expect(g.underPressure()).toBe(false);
    expect(g.locked("10.0.1.0")).toBe(false);
  });

  it("under pressure a /48 with 2 × pressureMax misses tightens its /64s with misses to tightMax", () => {
    const g = guardWith({ globalMax: 20 });
    for (let i = 0; i < 20; i++) g.record(`10.0.3.${i}`);
    expect(g.underPressure()).toBe(true);
    for (let i = 0; i < 10; i++) g.record(in48(i));
    const k = in48(500);
    expect(g.locked(k)).toBe(false);
    g.record(k);
    expect(g.locked(k)).toBe(false);
    g.record(k);
    expect(g.locked(k)).toBe(true);
    expect(g.locked(in48(501))).toBe(false);
  });

  it("a single locked key can't put the server under pressure", () => {
    const g = guardWith({ globalMax: 50 });
    for (let i = 0; i < 1000; i++) g.record("10.0.4.1");
    expect(g.locked("10.0.4.1")).toBe(true);
    expect(g.underPressure()).toBe(false);
  });
});
