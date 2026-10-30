import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";

// EXP-164 / EXP-166: per-IP limits on sockets and on join attempts with unknown codes, emoji allowlist + rate limit.
// Small limits so the test stays fast (read when the modules load).
vi.hoisted(() => {
  process.env.SOCKET_MAX_CONNECTIONS_PER_IP = "6";
  process.env.JOIN_MISS_MAX = "6"; // hard ceiling 18
  process.env.JOIN_EXEMPT_MAX = "3";
  process.env.JOIN_MISS_PREFIX_MAX = "8"; // per IPv6 /48 (EXP-183)
  // Clients pick their IP with X-Forwarded-For (one trusted hop: the test client is the "proxy"), so each test
  // has its own limits
  process.env.TRUST_PROXY = "1";
});

import { io } from "../app";
import { connections, joinMisses, roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

const harness = useTestServer();
const { once, joinAs: join } = harness;
/** IP the next client connects as (X-Forwarded-For) */
let clientIp = "10.0.0.1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects; resolves with the socket on connect, or the connect_error message. */
function tryConnect(): Promise<{ sock: ClientSocket; error?: string }> {
  const sock = harness.connectClient({ "x-forwarded-for": clientIp });
  return new Promise((resolve) => {
    sock.once("connect", () => resolve({ sock }));
    sock.once("connect_error", (e) => resolve({ sock, error: e.message }));
  });
}

async function newClient(): Promise<ClientSocket> {
  const { sock, error } = await tryConnect();
  if (error) throw new Error(error);
  return sock;
}

/** A well-formed room code that is not `gameCode` (no other room exists in these tests). */
const otherCode = (gameCode: string) => (gameCode === "ZZZZZZ" ? "YYYYYY" : "ZZZZZZ");

/** `n` joins with an unknown code, one fresh socket each (a socket records one miss per few seconds). */
async function missFrom(n: number, wrong: string): Promise<string[]> {
  const answers: string[] = [];
  for (let i = 0; i < n; i++) {
    const sock = await newClient();
    answers.push((await join(sock, wrong, `m${i}`)).message!);
    sock.disconnect();
    await sleep(20);
  }
  return answers;
}

async function closeAll() {
  harness.disconnectClients();
  await sleep(150); // the server frees the per-IP slots on disconnect
}

afterEach(closeAll);

describe("per-IP socket limits (EXP-164)", () => {
  it("refuses connections beyond the per-IP cap and frees a slot on disconnect", async () => {
    const open: ClientSocket[] = [];
    for (let i = 0; i < 6; i++) open.push(await newClient());
    const refused = await tryConnect();
    expect(refused.error).toBe("Too many connections");
    refused.sock.disconnect(); // its transport connection counts until closed

    open[0].disconnect();
    await sleep(150);
    const again = await tryConnect();
    expect(again.error).toBeUndefined();
  });

  it("frees the slot of a connection closed in the same request as its socket.io CONNECT", async () => {
    const base = `${harness.url}/socket.io/?EIO=4&transport=polling`;
    for (let i = 0; i < 10; i++) {
      const open = await (await fetch(base)).text(); // engine.io OPEN packet: 0{"sid":...}
      const sid = JSON.parse(open.slice(1)).sid as string;
      // socket.io CONNECT ("40") and engine.io CLOSE ("1") in one polling payload
      await fetch(`${base}&sid=${sid}`, { method: "POST", body: "40\x1e1", headers: { "Content-Type": "text/plain" } });
    }
    await sleep(200);
    expect(connections.count("127.0.0.1")).toBe(0);
    expect(connections.tracked()).toBe(0);
    // ...so the IP can still connect normally
    expect((await tryConnect()).error).toBeUndefined();
  });

  it("one socket.io socket per transport connection", async () => {
    const before = io.sockets.sockets.size;
    const base = `${harness.url}/socket.io/?EIO=4&transport=polling`;
    const sid = JSON.parse((await (await fetch(base)).text()).slice(1)).sid as string;
    await fetch(`${base}&sid=${sid}`, { method: "POST", body: "40\x1e40\x1e40", headers: { "Content-Type": "text/plain" } });
    await sleep(200);
    expect(io.sockets.sockets.size - before).toBe(1);
    await fetch(`${base}&sid=${sid}`, { method: "POST", body: "1", headers: { "Content-Type": "text/plain" } });
    await sleep(100);
    expect(io.sockets.sockets.size).toBe(before);
  });

  it("limits unknown-code joins per IP across sockets, without revealing which codes exist", async () => {
    clientIp = "10.0.0.2";
    const alice = await newClient();
    const created = await join(alice, null, "alice");
    const gameCode = created.room!.gameCode;
    const wrong = otherCode(gameCode);
    // alice is gone: her room has nobody connected on this IP, so no same-network exemption
    alice.disconnect();
    await sleep(100);

    // One socket records at most one miss every few seconds: 3 quick misses count once, and inside that cooldown
    // its joins with a code are answered without looking the code up (EXP-183)
    const quick = await newClient();
    const quickAnswers: string[] = [];
    for (const n of ["q1", "q2", "q3"]) quickAnswers.push((await join(quick, wrong, n)).message!);
    expect(quickAnswers).toEqual(["Game not found", "Too many attempts", "Too many attempts"]);
    expect(await join(quick, gameCode, "q4")).toEqual({ success: false, message: "Too many attempts" });
    quick.disconnect();
    // 4 more sockets, one miss each: 5 counted, still under the limit of 6
    for (let s = 0; s < 5; s++) {
      const sock = await newClient();
      expect((await join(sock, wrong, `g${s}`)).message).toBe("Game not found"); // the 5th makes 6
      sock.disconnect();
      await sleep(30);
    }

    // Over the limit: a real code and an unknown one get the same answer
    const probe = await newClient();
    expect(await join(probe, gameCode, "mallory")).toEqual({ success: false, message: "Too many attempts" });
    expect(await join(probe, wrong, "mallory")).toEqual({ success: false, message: "Too many attempts" });
    expect(roomManager.getRoom(gameCode)!.players.map((p) => p.username)).toEqual(["alice"]);
    probe.disconnect();

    // A player rejoining with its token is never locked out
    const back = await newClient();
    expect((await join(back, gameCode, "alice", created.rejoinToken)).success).toBe(true);
    // Now alice is connected from this IP: others on the same network can join her room despite the lockout
    const friend = await newClient();
    expect((await join(friend, gameCode, "bob")).success).toBe(true);
    // Creating a room needs no code and is not affected either
    const other = await newClient();
    expect((await join(other, null, "zoe")).success).toBe(true);
  });
});

describe("join lock: same-network exemption limits (EXP-164)", () => {
  async function lockedRoom() {
    const alice = await newClient();
    const created = await join(alice, null, "alice");
    const gameCode = created.room!.gameCode;
    const wrong = otherCode(gameCode);
    expect(await missFrom(6, wrong)).toEqual(Array(6).fill("Game not found"));
    return { gameCode, wrong, token: created.rejoinToken! };
  }

  it("caps exempted joins per IP while locked", async () => {
    clientIp = "10.0.0.3";
    const { gameCode } = await lockedRoom();
    for (const n of ["bob", "carl", "dan"]) expect((await join(await newClient(), gameCode, n)).success).toBe(true);
    expect(await join(await newClient(), gameCode, "erin")).toEqual({ success: false, message: "Too many attempts" });
  });

  it("keeps counting misses while locked; past the hard ceiling only token rejoins get in", async () => {
    clientIp = "10.0.0.4";
    const { gameCode, wrong, token } = await lockedRoom();
    expect((await join(await newClient(), gameCode, "bob")).success).toBe(true); // exempt: alice is connected here

    // 12 more misses while locked (same answer as for a real code) reach the ceiling of 18
    expect(await missFrom(12, wrong)).toEqual(Array(12).fill("Too many attempts"));
    expect(await join(await newClient(), gameCode, "carl")).toEqual({ success: false, message: "Too many attempts" });
    expect((await join(await newClient(), gameCode, "alice", token)).success).toBe(true);
  });
});

describe("join lock per IPv6 /48 (EXP-183)", () => {
  it("a full /48 locks its /64s that miss (at 2 own misses), not innocent /64s nor other /48s", async () => {
    clientIp = "2001:db8:100:1::1";
    const alice = await newClient();
    const created = await join(alice, null, "alice");
    const gameCode = created.room!.gameCode;
    const wrong = otherCode(gameCode);

    // 8 misses (JOIN_MISS_PREFIX_MAX), each from a different /64 of 2001:db8:100::/48: each /64 is far under its own
    // limit (6), the /48 is full
    for (let i = 0; i < 8; i++) {
      clientIp = `2001:db8:100:${(i + 2).toString(16)}::1`;
      expect(await missFrom(1, wrong)).toEqual(["Game not found"]);
    }

    // A rotating /64 gets one more answered guess (2 own misses), then can't tell a real code from a wrong one
    clientIp = "2001:db8:100:2::1";
    expect(await missFrom(1, wrong)).toEqual(["Game not found"]);
    expect(await join(await newClient(), gameCode, "mallory")).toEqual({ success: false, message: "Too many attempts" });
    // An innocent /64 of the same /48 with no misses of its own joins normally
    clientIp = "2001:db8:100:ff::1";
    expect((await join(await newClient(), gameCode, "bob")).success).toBe(true);
    // Another /48 is not affected
    clientIp = "2001:db8:200:1::1";
    expect((await join(await newClient(), gameCode, "carl")).success).toBe(true);
  });
});

describe("no answered guess without a recorded miss (EXP-183)", () => {
  it("N sockets × 5 rapid joins from one IP: 'Game not found' answers == recorded misses", async () => {
    clientIp = "10.0.0.6";
    const host = await newClient();
    const gameCode = (await join(host, null, "host")).room!.gameCode;
    host.disconnect();
    await sleep(100);
    // Well-formed codes of rooms that don't exist (only gameCode's room does)
    const ALPHABET_DIGITS = "23456789";
    const wrongCode = (s: number, j: number) => {
      const code = `ZZZZ${ALPHABET_DIGITS[s]}${ALPHABET_DIGITS[j]}`;
      return code === gameCode ? `YYYY${ALPHABET_DIGITS[s]}${ALPHABET_DIGITS[j]}` : code;
    };
    let notFound = 0;
    for (let s = 0; s < 4; s++) {
      const sock = await newClient();
      for (let j = 0; j < 5; j++) {
        // Wrong codes around the real one: the cooldown answer must not depend on whether the code exists
        const code = j === 2 ? gameCode : wrongCode(s, j);
        const res = await join(sock, code, `u${s}${j}`);
        if (res.message === "Game not found") notFound++;
        if (code === gameCode) expect(res).toEqual({ success: false, message: "Too many attempts" });
      }
      sock.disconnect();
      await sleep(20);
    }
    expect(notFound).toBe(4);
    expect(joinMisses.count("10.0.0.6")).toBe(notFound);
  });
});

describe("room code format (EXP-198)", () => {
  let malformedIp = 0; // one IP per malformed code, so each starts with no misses
  it("joins with the code typed in lowercase and with surrounding spaces", async () => {
    clientIp = "10.0.0.7";
    const host = await newClient();
    const gameCode = (await join(host, null, "host")).room!.gameCode;
    const lower = await join(await newClient(), gameCode.toLowerCase(), "bob");
    expect(lower.success).toBe(true);
    expect(lower.room!.gameCode).toBe(gameCode);
    expect((await join(await newClient(), `  ${gameCode} `, "carl")).success).toBe(true);
    expect(joinMisses.count("10.0.0.7")).toBe(0);
  });

  // Non-ASCII ones would alias real codes with String#toUpperCase ("ß" → "SS", "ſ" → "S", "ﬀ" → "FF")
  it.each(["123456", "OOOOOO", "ABCDE", "ABCDEFG", "AB CDE", "   ", "K7MQß", "K7MQ4ſ", "K7MQﬀ", "Ｋ７ＭＱ４Ｘ"])(
    "answers a malformed code %j with 'Game not found' and counts it as a miss, without looking it up", async (code) => {
      clientIp = `10.0.1.${++malformedIp}`;
      const lookups = vi.spyOn(roomManager, "getRoom");
      try {
        expect(await join(await newClient(), code, "mallory")).toEqual({ success: false, message: "Game not found" });
        expect(lookups).not.toHaveBeenCalled();
      } finally {
        lookups.mockRestore();
      }
      expect(joinMisses.count(clientIp)).toBe(1);
    },
  );
});

describe("emoji-reaction (EXP-166)", () => {
  it("relays only the app's emojis, rate-limited per socket", async () => {
    clientIp = "10.0.0.5";
    // Solo room: emoji-reaction is broadcast to the whole room, sender included
    const alice = await newClient();
    expect((await join(alice, null, "alice")).success).toBe(true);
    const got: string[] = [];
    alice.on("emoji-reaction", (d: { emoji: string }) => got.push(d.emoji));

    alice.emit("emoji-reaction", { emoji: "📸 Took a Screenshot" });
    alice.emit("emoji-reaction", { emoji: "Screenshot" });
    alice.emit("emoji-reaction", { emoji: "💩" });
    alice.emit("emoji-reaction", { emoji: "📸" });
    await sleep(200);
    expect(got).toEqual(["📸"]);

    // Burst of 20: only the bucket's burst gets through, the rest is dropped silently
    await sleep(1_500); // refill
    got.length = 0;
    for (let i = 0; i < 20; i++) alice.emit("emoji-reaction", { emoji: "🔥" });
    await sleep(300);
    expect(got.length).toBeGreaterThanOrEqual(5);
    expect(got.length).toBeLessThanOrEqual(7);
  });
});
