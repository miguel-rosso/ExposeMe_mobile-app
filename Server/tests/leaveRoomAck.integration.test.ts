import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-254: leave-room is acked once the server has handled it. The app closes its socket only on that ack: an event
// that socket.io dispatches after the disconnect is dropped, and the leave then looks like a lost connection (lobby:
// the player lingers as gone; mid-game: the game pauses waiting for them instead of ending).

const ACK_TIMEOUT_MS = 2_000;
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

/** Like the app's Exit: leave-room, and close the socket once the server acks it. */
async function leaveLikeTheApp(sock: ClientSocket): Promise<void> {
  await sock.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
  sock.disconnect();
}

/** alice (host) and bob in a lobby. */
async function lobby(): Promise<{ gameCode: string; alice: ClientSocket; bob: ClientSocket }> {
  const alice = await newClient();
  const created = once<{ room: { gameCode: string } }>(alice, "room-of-game");
  alice.emit("join-create-game", { gameCode: null, username: "alice" });
  const gameCode = (await created).room.gameCode;
  const bob = await newClient();
  const joined = once<{ success: boolean }>(bob, "room-of-game");
  const announced = once(alice, "player-joined");
  bob.emit("join-create-game", { gameCode, username: "bob" });
  expect((await joined).success).toBe(true);
  await announced;
  return { gameCode, alice, bob };
}

const playerNames = (gameCode: string) => roomManager.getRoom(gameCode)?.players.map((p) => p.username) ?? [];

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

describe("leave-room ack (EXP-254)", () => {
  it("acks only after the player is removed, so closing the socket on the ack is a voluntary leave", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    const noConnectionChange = silent(alice, "player-connection");

    await bob.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    expect(playerNames(gameCode)).toEqual(["alice"]); // handled before the ack
    bob.disconnect();

    expect(await left).toBe("bob");
    expect(await noConnectionChange).toBe(true); // never shown as a lost connection
  });

  it("the host's leave hands the host role over before the ack", async () => {
    const { gameCode, alice, bob } = await lobby();
    const newHost = once<{ username: string }>(bob, "new-host");

    await leaveLikeTheApp(alice);
    expect(roomManager.getRoom(gameCode)?.players.map((p) => [p.username, p.isHost])).toEqual([["bob", true]]);
    expect((await newHost).username).toBe("bob");
  });

  it("mid-game, a leave closed on the ack ends a 2-player game instead of pausing it", async () => {
    const { alice, bob } = await lobby();
    const started = [alice, bob].map((c) => once(c, "game-started"));
    alice.emit("start-game");
    await Promise.all(started);
    const firstTurn = once(alice, "waiting-photo");
    [alice, bob].forEach((c) => c.emit("im-ready"));
    await firstTurn;

    const gameOver = once(alice, "game-over");
    const notPaused = silent(alice, "game-paused");
    await leaveLikeTheApp(bob);

    await gameOver;
    expect(await notPaused).toBe(true);
  });

  it("a socket bound to no room gets the ack too (nothing to leave)", async () => {
    const stranger = await newClient();
    await expect(stranger.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room")).resolves.toBeUndefined();
  });
});
