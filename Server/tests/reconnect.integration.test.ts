import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-006: a player who drops mid-round and comes back on a new socket (socket.io reconnect) rejoins
// with the rejoin token and gets a game-state snapshot; with only 2 players the game pauses meanwhile.
// Real server, production timings (each test stays within the first round, ~1–4 s).

const PHOTO = "/temp/" + "a".repeat(32) + ".jpg"; // shape of a POST /upload result

interface RoomOfGame { success: boolean; rejoinToken?: string; room?: { gameCode: string } }

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
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
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken ? { rejoinToken } : {}) });
  return res;
}

/** Resolves true if `event` is NOT received within `ms`. */
function silent(socket: ClientSocket, event: string, ms = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

/** Players in a started game; resolves when the first round-start reached everyone. */
async function gameInAnsweringPhase(names: string[]) {
  const socks: Record<string, ClientSocket> = {};
  const tokens: Record<string, string> = {};
  socks[names[0]] = await newClient();
  const created = await joinAs(socks[names[0]], null, names[0]);
  const gameCode = created.room!.gameCode;
  tokens[names[0]] = created.rejoinToken!;
  for (const n of names.slice(1)) {
    socks[n] = await newClient();
    tokens[n] = (await joinAs(socks[n], gameCode, n)).rejoinToken!;
  }
  const turns = names.map((n) => once<{ round: number }>(socks[n], "your-turn").then(() => n).catch(() => null));
  const started = names.map((n) => once(socks[n], "game-started"));
  socks[names[0]].emit("start-game");
  await Promise.all(started);
  names.forEach((n) => socks[n].emit("im-ready"));
  const owner = await Promise.race(turns.map((p) => p.then((n) => n ?? new Promise<string>(() => {}))));
  const starts = names.map((n) => once<{ round: number; owner: string }>(socks[n], "round-start"));
  socks[owner].emit("photo-sent", { photo: PHOTO });
  await Promise.all(starts);
  return { gameCode, socks, tokens, owner };
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

describe("reconnect mid-round", () => {
  it("3 players: the returning player gets the current phase, photo and remaining time; no pause", async () => {
    const { gameCode, socks, tokens, owner } = await gameInAnsweringPhase(["alice", "bob", "carol"]);
    const away = ["alice", "bob", "carol"].find((n) => n !== owner)!;
    const stay = ["alice", "bob", "carol"].find((n) => n !== owner && n !== away)!;
    let paused = false;
    socks[stay].on("game-paused", () => { paused = true; });

    socks[away].disconnect();
    await new Promise((r) => setTimeout(r, 500));
    const back = await newClient();
    const snap = once<Record<string, unknown>>(back, "game-state");
    const res = await joinAs(back, gameCode, away, tokens[away]);
    expect(res.success).toBe(true);
    const s = await snap;
    expect(s).toMatchObject({ started: true, phase: "answering", round: 1, owner, photo: PHOTO, pause: null });
    expect(s.duration as number).toBeGreaterThan(3_000);
    expect(s.duration as number).toBeLessThanOrEqual(8_000);

    // The returning socket keeps receiving the round
    const reveal = await once<{ correctAnswer: string }>(back, "round-reveal", 9_000);
    expect(reveal.correctAnswer).toBe(owner);
    expect(paused).toBe(false);
    Object.values(socks).forEach((c) => c.emit("leave-room"));
    back.emit("leave-room");
  }, 15_000);

  it("2 players: the game pauses for the one left, and resumes for both when the other returns", async () => {
    const { gameCode, socks, tokens, owner } = await gameInAnsweringPhase(["dave", "erin"]);
    const away = owner === "dave" ? "erin" : "dave";
    const pausedP = once<{ duration: number; waitingFor: string[] }>(socks[owner], "game-paused");
    socks[away].disconnect();
    expect(await pausedP).toEqual({ duration: 5 * 60_000, waitingFor: [away] });

    // Frozen: no reveal while paused, even past the answer time
    let revealed = false;
    socks[owner].on("round-reveal", () => { revealed = true; });
    await new Promise((r) => setTimeout(r, 8_500));
    expect(revealed).toBe(false);

    const back = await newClient();
    const snap = once<Record<string, unknown>>(back, "game-state");
    const resumedBack = once<{ phase: string; duration: number }>(back, "game-resumed");
    const resumedOwner = once<{ phase: string; duration: number }>(socks[owner], "game-resumed");
    expect((await joinAs(back, gameCode, away, tokens[away])).success).toBe(true);
    const s = await snap;
    expect(s).toMatchObject({ phase: "answering", owner, photo: PHOTO });
    expect(s.pause).toBeNull(); // sent after the resume
    const [rb, ro] = await Promise.all([resumedBack, resumedOwner]);
    expect(rb).toEqual(ro);
    expect(rb.phase).toBe("answering");
    expect(rb.duration).toBeGreaterThan(3_000);

    const reveal = await once<{ correctAnswer: string }>(back, "round-reveal", 9_000);
    expect(reveal.correctAnswer).toBe(owner);
    socks[owner].emit("leave-room");
    back.emit("leave-room");
  }, 25_000);

  it("a replaced socket and a kicked player's sockets are cut off: no round-start (photo URL) reaches them", async () => {
    const sock: Record<string, ClientSocket> = {};
    const tokens: Record<string, string> = {};
    sock.host = await newClient();
    const created = await joinAs(sock.host, null, "host");
    const gameCode = created.room!.gameCode;
    for (const n of ["bob", "carol", "dave"]) {
      sock[n] = await newClient();
      tokens[n] = (await joinAs(sock[n], gameCode, n)).rejoinToken!;
    }

    // bob rejoins on a second socket while the first one is still alive: the first is evicted
    const bobOldClosed = once(sock.bob, "disconnect");
    const bob2 = await newClient();
    expect((await joinAs(bob2, gameCode, "bob", tokens.bob)).success).toBe(true);
    await bobOldClosed;

    // carol too, then the host kicks carol: both of her sockets are out
    const carol2 = await newClient();
    const carolOldClosed = once(sock.carol, "disconnect");
    const res = await joinAs(carol2, gameCode, "carol", tokens.carol);
    await carolOldClosed;
    const carolId = (res.room as unknown as { players: { username: string; socketId: string }[] }).players.find((p) => p.username === "carol")!.socketId;
    const carol2Closed = once(carol2, "disconnect");
    sock.host.emit("remove-player", { socketId: carolId });
    await carol2Closed;

    const cutOff = [sock.bob, sock.carol, carol2].map((c) => silent(c, "round-start", 6_000));
    const live = [sock.host, bob2, sock.dave];
    const turns = live.map((c) => once<{ round: number }>(c, "your-turn", 5_000).then(() => c).catch(() => null));
    const started = live.map((c) => once(c, "game-started"));
    sock.host.emit("start-game");
    await Promise.all(started);
    live.forEach((c) => c.emit("im-ready"));
    const owner = await Promise.race(turns.map((p) => p.then((c) => c ?? new Promise<ClientSocket>(() => {}))));
    const starts = live.map((c) => once(c, "round-start"));
    owner.emit("photo-sent", { photo: PHOTO });
    await Promise.all(starts);
    expect(await Promise.all(cutOff)).toEqual([true, true, true]);
    live.forEach((c) => c.emit("leave-room"));
  }, 20_000);
});
