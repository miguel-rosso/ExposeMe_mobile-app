import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";

// EXP-164 / EXP-166: per-IP limits on sockets and on join attempts with unknown codes, emoji allowlist + rate limit.
// Small limits so the test stays fast (read when the modules load).
vi.hoisted(() => {
  process.env.SOCKET_MAX_CONNECTIONS_PER_IP = "6";
  process.env.JOIN_MISS_MAX = "6"; // hard ceiling 18
  process.env.JOIN_EXEMPT_MAX = "3";
  // Clients pick their IP with X-Forwarded-For (one trusted hop: the test client is the "proxy"), so each test
  // has its own limits
  process.env.TRUST_PROXY = "1";
});

import { io, server } from "../app";
import { connections, roomManager } from "../routes/socketRoutes";

interface RoomOfGame { success: boolean; message?: string; rejoinToken?: string; room?: { gameCode: string } }

let url: string;
let clients: ClientSocket[] = [];
/** IP the next client connects as (X-Forwarded-For) */
let clientIp = "10.0.0.1";

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connects; resolves with the socket on connect, or the connect_error message. */
function tryConnect(): Promise<{ sock: ClientSocket; error?: string }> {
  const sock = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { "x-forwarded-for": clientIp } });
  clients.push(sock);
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

function join(sock: ClientSocket, gameCode: string | null, username: string, rejoinToken?: string): Promise<RoomOfGame> {
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken ? { rejoinToken } : {}) });
  return res;
}

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
  clients.forEach((c) => c.disconnect());
  clients = [];
  await sleep(150); // the server frees the per-IP slots on disconnect
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(closeAll);

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
});

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
    const base = `${url}/socket.io/?EIO=4&transport=polling`;
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
    const base = `${url}/socket.io/?EIO=4&transport=polling`;
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
    const wrong = gameCode === "100000" ? "100001" : "100000";
    // alice is gone: her room has nobody connected on this IP, so no same-network exemption
    alice.disconnect();
    await sleep(100);

    // One socket records at most one miss every few seconds: 3 quick misses count once
    const quick = await newClient();
    for (const n of ["q1", "q2", "q3"]) expect((await join(quick, wrong, n)).message).toBe("Game not found");
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
    const wrong = gameCode === "100000" ? "100001" : "100000";
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
