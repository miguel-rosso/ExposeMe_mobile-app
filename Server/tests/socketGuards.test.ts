import { describe, expect, it } from "vitest";
import { ALLOWED_EMOJIS, createConnectionCounter, createTokenBucket, handshakeIp, ipKey } from "../managers/socketGuards";
import { RoomManager } from "../managers/RoomManager";
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
