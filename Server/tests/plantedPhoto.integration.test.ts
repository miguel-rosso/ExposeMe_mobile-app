import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { registerUpload } from "./helpers";

// EXP-126 / EXP-035: the app plants its photo from the lobby (upload + plant-photo). Whether a player planted one is
// told only to that player (room-of-game `hasPlantedPhoto`), never in anyone's player data, and no message can drop
// a planted photo once the game started.

interface RoomOfGame {
  success: boolean;
  room: { gameCode: string; started: boolean; players: Record<string, unknown>[] };
  rejoinToken: string;
  hasPlantedPhoto?: boolean;
}

const PLANTED = "/temp/" + "e".repeat(32) + ".jpg";
const LATE = "/temp/" + "f".repeat(32) + ".jpg";

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

async function join(c: ClientSocket, gameCode: string | null, username: string): Promise<RoomOfGame> {
  const res = once<RoomOfGame>(c, "room-of-game");
  c.emit("join-create-game", { gameCode, username });
  const data = await res;
  expect(data.success).toBe(true);
  return data;
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

describe("planted photo from the lobby", () => {
  it("own mark only in the planter's room-of-game; nothing drops it after the start; none accepted after round 1", async () => {
    const alice = await newClient();
    const created = await join(alice, null, "alice");
    expect(created.hasPlantedPhoto).toBe(false);
    const gameCode = created.room.gameCode;
    const bob = await newClient();
    expect((await join(bob, gameCode, "bob")).hasPlantedPhoto).toBe(false);

    // bob plants from the lobby
    registerUpload(gameCode, "bob", PLANTED);
    bob.emit("plant-photo", { photoUrl: PLANTED });
    await until(() => roomManager.getPlayer(gameCode, "bob")?.plantedPhoto === PLANTED);
    const mine = await join(bob, gameCode, "bob"); // same socket re-sending its join: the lobby's resync answer
    expect(mine.hasPlantedPhoto).toBe(true);
    for (const p of mine.room.players) {
      expect(p).not.toHaveProperty("hasPlantedPhoto");
      expect(p).not.toHaveProperty("isReady");
    }

    // Nobody else learns it
    const theirs = await join(alice, gameCode, "alice");
    expect(theirs.hasPlantedPhoto).toBe(false);
    for (const p of theirs.room.players) expect(p).not.toHaveProperty("hasPlantedPhoto");
    const carol = await newClient();
    const joined = once<Record<string, unknown>>(alice, "player-joined");
    await join(carol, gameCode, "carol");
    const joinedPlayer = await joined;
    expect(joinedPlayer).not.toHaveProperty("hasPlantedPhoto");
    expect(joinedPlayer).not.toHaveProperty("isReady");

    // Game starts: no player data says who is ready (the planter used to be the last one, uploading)
    const started = [alice, bob, carol].map((c) => once<Record<string, unknown>[]>(c, "game-started"));
    alice.emit("start-game");
    for (const players of await Promise.all(started)) for (const p of players) expect(p).not.toHaveProperty("isReady");
    // The removed lobby mark event (old clients) can't drop the planted photo
    bob.emit("mark-player-planted", { planted: false });
    const firstRound = once(alice, "round-start", 8_000);
    for (const n of ["alice", "bob", "carol"]) {
      const c = { alice, bob, carol }[n]!;
      c.once("your-turn", () => {
        const photo = "/temp/" + n[0].repeat(32) + ".jpg";
        registerUpload(gameCode, n, photo);
        c.emit("photo-sent", { photo });
      });
    }
    [alice, bob, carol].forEach((c) => c.emit("im-ready"));
    await firstRound;
    const room = roomManager.getRoom(gameCode)!;
    expect(room.round).toBe(1);
    // Planted round 1 consumed it; otherwise it is still there for a later round
    expect(room.plantedPhotosShown === 1 || roomManager.getPlayer(gameCode, "bob")!.plantedPhoto === PLANTED).toBe(true);

    // After round 1 is played no planted photo is accepted any more
    registerUpload(gameCode, "carol", LATE);
    carol.emit("plant-photo", { photoUrl: LATE });
    await new Promise((r) => setTimeout(r, 200));
    expect(roomManager.getPlayer(gameCode, "carol")!.plantedPhoto).toBeUndefined();
    expect((await join(carol, gameCode, "carol")).hasPlantedPhoto).toBe(false);
  }, 15_000);
});
