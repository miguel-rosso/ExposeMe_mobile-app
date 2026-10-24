import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { MAX_PLAYERS_PER_ROOM, MAX_ROOMS } from "../managers/RoomManager";
import { roomManager } from "../routes/socketRoutes";

// One socket = at most one player in one room. Re-sending join for the same room and username
// (what the app does on every reconnect / "Play again") is a no-op rejoin; anything else leaves the old binding first.

interface RoomOfGame {
  success: boolean;
  message?: string;
  rejoinToken?: string;
  room?: { gameCode: string; players: { username: string; isHost: boolean; connected: boolean }[] };
}

const QUIET_MS = 300;

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Resolves true if `event` is NOT received within `ms`. */
function silent(socket: ClientSocket, event: string, ms = QUIET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

async function joinAs(sock: ClientSocket, gameCode: string | null, username: string, rejoinToken?: string): Promise<RoomOfGame> {
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken !== undefined ? { rejoinToken } : {}) });
  return res;
}

/** Players currently in `gameCode`, as seen by a fresh joiner (works for lobbies only). */
async function roomPlayers(gameCode: string): Promise<{ username: string; isHost: boolean }[]> {
  const probe = await newClient();
  const res = await joinAs(probe, gameCode, `probe${clients.length}`);
  probe.emit("leave-room");
  probe.disconnect();
  return res.room!.players.filter((p) => !p.username.startsWith("probe"));
}

async function playersOf(gameCode: string): Promise<string[]> {
  return (await roomPlayers(gameCode)).map((p) => p.username);
}

/** Room with `MAX_PLAYERS_PER_ROOM` players p0..p11 (p0 host). */
async function fullRoom(): Promise<{ gameCode: string; socks: ClientSocket[]; tokens: string[] }> {
  const host = await newClient();
  const created = await joinAs(host, null, "p0");
  const gameCode = created.room!.gameCode;
  const tokens: string[] = [created.rejoinToken!];
  const socks: ClientSocket[] = [host];
  for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) {
    const s = await newClient();
    const r = await joinAs(s, gameCode, `p${i}`);
    expect(r.success).toBe(true);
    tokens.push(r.rejoinToken!);
    socks.push(s);
  }
  return { gameCode, socks, tokens };
}

async function lobby(): Promise<{ gameCode: string; alice: ClientSocket; bob: ClientSocket; tokens: Record<string, string> }> {
  const alice = await newClient();
  const created = await joinAs(alice, null, "alice");
  const gameCode = created.room!.gameCode;
  const bob = await newClient();
  const announced = once(alice, "player-joined");
  const joined = await joinAs(bob, gameCode, "bob");
  await announced;
  return { gameCode, alice, bob, tokens: { alice: created.rejoinToken!, bob: joined.rejoinToken! } };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
});

describe("one socket, one room binding", () => {
  it("re-sending join for the same room and username is a no-op rejoin (with or without token)", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const quietJoin = silent(alice, "player-joined");
    const quietLeft = silent(alice, "player-left");

    const again = await joinAs(bob, gameCode, "bob", tokens.bob);
    expect(again.success).toBe(true);
    expect(again.rejoinToken).toBe(tokens.bob);
    const noToken = await joinAs(bob, gameCode.toLowerCase(), "bob");
    expect(noToken.success).toBe(true);
    expect(noToken.rejoinToken).toBe(tokens.bob);

    expect(await quietJoin).toBe(true);
    expect(await quietLeft).toBe(true);
    expect(await playersOf(gameCode)).toEqual(["alice", "bob"]);

    // still bound: bob keeps receiving room broadcasts
    const chat = once<{ username: string }>(bob, "chat-message");
    alice.emit("chat-message", { message: "hi" });
    expect((await chat).username).toBe("alice");
  });

  it("joining another room leaves the previous one (no ghost player, no events from the old room)", async () => {
    const a = await lobby();
    const carol = await newClient();
    const b = (await joinAs(carol, null, "carol")).room!.gameCode;

    const left = once<string>(a.alice, "player-left");
    const res = await joinAs(a.bob, b, "bob");
    expect(res.success).toBe(true);
    expect(res.room!.gameCode).toBe(b);
    expect(await left).toBe("bob");

    expect(await playersOf(a.gameCode)).toEqual(["alice"]);
    expect(await playersOf(b)).toEqual(["carol", "bob"]);

    const quiet = silent(a.bob, "chat-message");
    a.alice.emit("chat-message", { message: "old room" });
    expect(await quiet).toBe(true);
  });

  it("creating a room while in another leaves the previous one and hands over host", async () => {
    const { gameCode, alice, bob } = await lobby();
    const newHost = once<{ username: string }>(bob, "new-host");
    const left = once<string>(bob, "player-left");
    const res = await joinAs(alice, null, "alice");
    expect(res.success).toBe(true);
    expect(res.room!.gameCode).not.toBe(gameCode);
    expect((await newHost).username).toBe("bob");
    expect(await left).toBe("alice");
    expect(await playersOf(gameCode)).toEqual(["bob"]);
  });

  it("joining the same room under another username replaces the socket's own player", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    const joined = once<{ username: string }>(alice, "player-joined");
    expect((await joinAs(bob, gameCode, "bobby")).success).toBe(true);
    expect(await left).toBe("bob");
    expect((await joined).username).toBe("bobby");
    expect(await playersOf(gameCode)).toEqual(["alice", "bobby"]);
  });

  it("a failed join (unknown code, full room, started game) keeps the socket in its room, still host", async () => {
    const { gameCode, alice, bob } = await lobby();
    const full = await fullRoom();
    const started = await lobby();
    const ss = once(started.alice, "game-started");
    started.alice.emit("start-game");
    await ss;

    const quietLeft = silent(bob, "player-left", 600);
    const quietHost = silent(bob, "new-host", 600);
    expect(await joinAs(alice, "000000", "alice")).toEqual({ success: false, message: "Game not found" });
    expect(await joinAs(alice, full.gameCode, "alice")).toEqual({ success: false, message: "Room is full" });
    expect(await joinAs(alice, started.gameCode, "alice")).toEqual({ success: false, message: "Game already started" });
    expect(await quietLeft).toBe(true);
    expect(await quietHost).toBe(true);

    expect(await roomPlayers(gameCode)).toEqual([
      expect.objectContaining({ username: "alice", isHost: true }),
      expect.objectContaining({ username: "bob", isHost: false }),
    ]);
    // still bound: host actions and room broadcasts work
    const rounds = once<number>(bob, "rounds-updated");
    alice.emit("set-rounds", { rounds: 15 });
    expect(await rounds).toBe(15);
  });

  it("switching username inside a full room frees the socket's own slot", async () => {
    const { gameCode, socks } = await fullRoom();
    const res = await joinAs(socks[3], gameCode, "p3b");
    expect(res.success).toBe(true);
    const names = res.room!.players.map((p) => p.username);
    expect(names).toHaveLength(MAX_PLAYERS_PER_ROOM);
    expect(names).toContain("p3b");
    expect(names).not.toContain("p3");
  });
});

describe("room capacity", () => {
  it(`rejects the ${MAX_PLAYERS_PER_ROOM + 1}th player with "Room is full", rejoins still work`, async () => {
    const { gameCode, socks, tokens } = await fullRoom();
    const extra = await newClient();
    expect(await joinAs(extra, gameCode, "extra")).toEqual({ success: false, message: "Room is full" });

    socks[5].disconnect();
    const back = await newClient();
    expect((await joinAs(back, gameCode, "p5", tokens[5])).success).toBe(true);
  });
});

describe("join abuse limits", () => {
  it("answers \"Too many attempts\" after 5 joins within 10 s on one socket, and recovers after the window", async () => {
    const c = await newClient();
    for (let i = 0; i < 5; i++) expect(await joinAs(c, null, "")).toEqual({ success: false, message: "Invalid username" });
    expect(await joinAs(c, null, "dave")).toEqual({ success: false, message: "Too many attempts" });

    // the limit is per socket: another socket is unaffected
    expect((await joinAs(await newClient(), null, "erin")).success).toBe(true);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10_001);
      expect((await joinAs(c, null, "dave")).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`refuses to create rooms beyond ${MAX_ROOMS} with "Server is busy" (joining existing rooms still works)`, async () => {
    const { gameCode } = await lobby();
    const filler: string[] = [];
    while (!roomManager.isAtCapacity()) filler.push(roomManager.createRoom("filler", "none").gameCode);
    try {
      expect(await joinAs(await newClient(), null, "frank")).toEqual({ success: false, message: "Server is busy" });
      expect((await joinAs(await newClient(), gameCode, "gina")).success).toBe(true);
    } finally {
      filler.forEach((code) => roomManager.deleteRoom(code));
    }
    expect((await joinAs(await newClient(), null, "frank")).success).toBe(true);
  });
});
