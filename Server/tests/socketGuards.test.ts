import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EMOJIS, createConnectionCounter, createEventLimiter, createTokenBucket, GAME_EVENT_LIMITS, handshakeIp,
  HOLD_START_BURST, ipKey,
} from "../managers/socketGuards";
import { MAX_PLAYERS_PER_ROOM, RoomManager } from "../managers/RoomManager";
import { isRoomCode } from "../managers/roomCode";

const req = (remoteAddress: string, xff?: string) => ({
  socket: { remoteAddress },
  headers: xff ? { "x-forwarded-for": xff } : {},
}) as unknown as Parameters<typeof handshakeIp>[0];

describe("handshakeIp (same rules as Express trust proxy)", () => {
  it("uses the remote address when no proxy is trusted, ignoring X-Forwarded-For", () => {
    expect(handshakeIp(req("10.0.0.1", "6.6.6.6"), 0)).toBe("10.0.0.1");
  });

  it("with 1 trusted hop takes the entry the proxy appended, not a client-supplied one", () => {
    expect(handshakeIp(req("10.0.0.1", "6.6.6.6, 203.0.113.7"), 1)).toBe("203.0.113.7");
    expect(handshakeIp(req("10.0.0.1", "203.0.113.7"), 1)).toBe("203.0.113.7");
  });

  it("falls back to the farthest address when the chain is shorter than the hops", () => {
    expect(handshakeIp(req("10.0.0.1"), 2)).toBe("10.0.0.1");
    expect(handshakeIp(req("10.0.0.1", "203.0.113.7"), 2)).toBe("203.0.113.7");
  });
});

describe("createConnectionCounter", () => {
  it("is over the cap past max open per IP, and drops an IP's entry at 0", () => {
    const c = createConnectionCounter(2);
    c.acquire("a");
    c.acquire("a");
    expect(c.over("a")).toBe(false);
    c.acquire("a");
    expect(c.over("a")).toBe(true);
    expect(c.over("b")).toBe(false);
    c.release("a");
    expect(c.over("a")).toBe(false);
    c.release("a");
    c.release("a");
    expect(c.tracked()).toBe(0);
  });
});

describe("ipKey", () => {
  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    // Any notation of a mapped address: expanded first, then mapped
    expect(ipKey("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("0000:0000:0000:0000:0000:ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("strips brackets and ports", () => {
    expect(ipKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(ipKey("[2001:db8:1:2::1]:443")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[2001:db8:1:2::1]")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[::ffff:203.0.113.7]:80")).toBe("203.0.113.7");
  });

  it("groups IPv6 by /64 prefix, whatever the notation", () => {
    const k = ipKey("2001:db8:1:2::1");
    expect(k).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc")).toBe(k);
    expect(ipKey("2001:db8:1:2:0:0:0:9%eth0")).toBe(k);
    expect(ipKey("2001:db8:1:3::1")).not.toBe(k);
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("createTokenBucket", () => {
  it("allows a burst, then refills at the rate", () => {
    let t = 0;
    const b = createTokenBucket(3, 2, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    t = 500; // +1 token
    expect([b.take(), b.take()]).toEqual([true, false]);
  });
});

describe("createEventLimiter (EXP-062)", () => {
  it("keeps one bucket per event, each with its own burst and rate", () => {
    let t = 0;
    const limiter = createEventLimiter({ a: { burst: 2, ratePerS: 1 }, b: { burst: 1, ratePerS: 4 } }, () => t);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect([limiter.take("b"), limiter.take("b")]).toEqual([true, false]); // "a" being empty doesn't affect "b"
    t = 250; // +1/4 token for "a", +1 for "b"
    expect([limiter.take("a"), limiter.take("b")]).toEqual([false, true]);
    t = 1_000;
    expect(limiter.take("a")).toBe(true);
  });
});

describe("GAME_EVENT_LIMITS (EXP-062)", () => {
  it("lets through what a legitimate client sends at once", () => {
    // The app's bursts: the host kicks every other player of a full room, re-taps start, rejoins re-send im-ready
    expect(GAME_EVENT_LIMITS["remove-player"].burst).toBeGreaterThanOrEqual(MAX_PLAYERS_PER_ROOM - 1);
    expect(GAME_EVENT_LIMITS["hold-end"].burst).toBeGreaterThanOrEqual(HOLD_START_BURST);
    for (const { burst, ratePerS } of Object.values(GAME_EVENT_LIMITS)) {
      expect(burst).toBeGreaterThanOrEqual(3);
      expect(ratePerS).toBeGreaterThan(0);
    }
  });

  it("match the table in GAME_FLOW.md (Per-socket event limits)", () => {
    const doc = readFileSync(join(__dirname, "..", "GAME_FLOW.md"), "utf8");
    const heading = "## Per-socket event limits";
    expect(doc).toContain(heading);
    const section = doc.slice(doc.indexOf(heading) + heading.length).split(/\n## /)[0];
    // `| \`event\` | burst N…, refilled R/s` or `refilled 1 every S s`
    const documented = new Map(
      [...section.matchAll(/^\| `([a-z-]+)` \| burst (\d+)\b.*?refilled (?:([\d.]+)\/s|1 every ([\d.]+) s)/gm)]
        .map(([, event, burst, perS, everyS]) => [event, { burst: Number(burst), ratePerS: perS ? Number(perS) : 1 / Number(everyS) }]),
    );
    for (const [event, limit] of Object.entries(GAME_EVENT_LIMITS)) {
      expect(documented.get(event), `GAME_FLOW.md limit of ${event}`).toEqual(limit);
    }
  });
});

describe("ALLOWED_EMOJIS (EXP-166)", () => {
  it("is exactly the app's picker plus the screenshot marker", () => {
    expect([...ALLOWED_EMOJIS]).toEqual(["😂", "😍", "❓", "😳", "🔥", "😭", "🤡", "😡", "📸"]);
  });
});

describe("room codes (EXP-164)", () => {
  it("are 6 characters from crypto.randomInt, not Math.random", () => {
    const rm = new RoomManager();
    const original = Math.random;
    Math.random = () => { throw new Error("Math.random used for a room code"); };
    try {
      const codes = Array.from({ length: 200 }, (_, i) => rm.createRoom(`u${i}`, `s${i}`).gameCode);
      codes.forEach((c) => expect(isRoomCode(c)).toBe(true));
      expect(new Set(codes).size).toBe(200);
    } finally {
      Math.random = original;
      rm.clear();
    }
  });

  it("canRejoin only with that player's token", () => {
    const rm = new RoomManager();
    const room = rm.createRoom("alice", "s1");
    const token = room.players[0].rejoinToken;
    expect(rm.canRejoin(room.gameCode, "alice", token)).toBe(true);
    expect(rm.canRejoin(room.gameCode, "alice", "nope")).toBe(false);
    expect(rm.canRejoin(room.gameCode, "bob", token)).toBe(false);
    expect(rm.canRejoin("000000", "alice", token)).toBe(false);
    rm.clear();
  });
});
