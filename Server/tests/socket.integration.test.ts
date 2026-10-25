import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { registerUpload } from "./helpers";
import { ANSWER_GRACE } from "../managers/GameEngine";

// Real server on an ephemeral port + 3 real socket.io clients.
// Production timings are kept; this only covers lobby → first round-start (~1s, GAME_START_DELAY).

const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg"; // shape of a POST /upload result

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

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear(); // pending room deletions / game timers must not outlive the server
  vi.restoreAllMocks();
});

describe("socket flow", () => {
  it("join → start → im-ready → your-turn → photo-sent → round-start reaches all clients", async () => {
    const [alice, bob, carol] = [await newClient(), await newClient(), await newClient()];
    const byName: Record<string, ClientSocket> = { alice, bob, carol };

    // Create
    const created = once<{ success: boolean; room: { gameCode: string } }>(alice, "room-of-game");
    alice.emit("join-create-game", { gameCode: null, username: "alice" });
    const { room } = await created;
    const gameCode = room.gameCode;
    expect(gameCode).toMatch(/^\d{6}$/);

    // Join
    for (const [name, sock] of [["bob", bob], ["carol", carol]] as const) {
      const joined = once<{ success: boolean; room: { players: { username: string }[] } }>(sock, "room-of-game");
      const announced = once<{ username: string }>(alice, "player-joined");
      sock.emit("join-create-game", { gameCode, username: name });
      expect((await joined).success).toBe(true);
      expect((await announced).username).toBe(name);
    }

    // Start
    const started = [alice, bob, carol].map((c) => once<unknown[]>(c, "game-started"));
    alice.emit("start-game", { gameCode });
    await Promise.all(started);

    // Ready → exactly one player gets your-turn
    const turn = new Promise<{ name: string; data: { round: number } }>((resolve) => {
      for (const [name, sock] of Object.entries(byName)) sock.once("your-turn", (data) => resolve({ name, data }));
    });
    for (const [name, sock] of Object.entries(byName)) sock.emit("im-ready", { gameCode, username: name });
    const { name: owner, data: turnData } = await turn;
    expect(turnData).toEqual({ round: 1, attempt: 1 });

    // Photo → round-start broadcast to everyone
    const roundStarts = [alice, bob, carol].map((c) => once<Record<string, unknown>>(c, "round-start"));
    registerUpload(gameCode, owner, PHOTO); // as if the owner had uploaded it (photo-sent takes only own uploads)
    byName[owner].emit("photo-sent", { photo: PHOTO, gameCode });
    const payloads = await Promise.all(roundStarts);
    // Same payload for everyone, without the owner's name; only the owner's copy says isOwner (EXP-128)
    payloads.forEach((p, i) => expect(p).toEqual({ photo: PHOTO, round: 1, duration: 8_000 - ANSWER_GRACE, isOwner: ["alice", "bob", "carol"][i] === owner }));

    // Everybody leaves → room reset (its deletion timer is cleared in afterAll)
    for (const c of [alice, bob, carol]) c.emit("leave-room");
  });

  it("teardown (roomManager.clear) leaves no rooms and no pending deletion timers", async () => {
    const c = await newClient();
    const created = once(c, "room-of-game");
    c.emit("join-create-game", { gameCode: null, username: "dave" });
    await created;
    c.emit("leave-room"); // empty room → deletion scheduled
    // Events of one socket are handled in order: this answer means leave-room was processed
    const probe = once<{ success: boolean }>(c, "room-of-game");
    c.emit("join-create-game", { gameCode: "000000", username: "dave" });
    expect((await probe).success).toBe(false);
    expect(roomManager.stats().pendingDeletions).toBeGreaterThan(0);

    roomManager.clear();
    expect(roomManager.stats()).toEqual({ rooms: 0, pendingDeletions: 0 });
  });
});
