import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { GameEngine } from "../managers/GameEngine";
import { GAME_EVENT_LIMITS, type LimitedGameEvent } from "../managers/socketGuards";
import { registerTurnUpload, registerUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-062: lobby/game events are rate-limited per socket (GAME_EVENT_LIMITS). A flood of each event reaches its
// handler's work at most `burst` times; the rest is dropped silently. The real handlers' targets are stubbed so every
// accepted event reaches them (e.g. start-game would otherwise start the game and ignore the rest anyway).
// Date is frozen for each test (before its sockets connect, so the per-socket buckets read the fake clock): no token
// is refilled during a flood, whatever the machine's speed.

const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg"; // shape of a POST /upload result
/** Events sent per flood, as a multiple of the event's burst */
const FLOOD_FACTOR = 3;
const DEFAULT_ROUNDS = 10; // RoomManager.createRoom
const OTHER_ROUNDS = 15;

// Every test plays in a lobby of its own, so each one's rooms and sockets are dropped after it
const { newClient, joinAs } = useTestServer({ resetBetweenTests: true });

/**
 * Joins `sock` as `username` into `gameCode` (null creates a room); resolves with the room code. Re-sent for the
 * room and username the socket already has, it is a no-op answered at once: a barrier, since one socket's events are
 * handled in order, everything it sent before has been handled when the answer arrives.
 */
async function join(sock: ClientSocket, username: string, gameCode: string | null = null): Promise<string> {
  const { success, room } = await joinAs(sock, gameCode, username);
  expect(success).toBe(true);
  return room!.gameCode;
}

/** A lobby with a host and a guest, each on its own socket (fresh per-socket limits). */
async function lobby() {
  const host = await newClient();
  const guest = await newClient();
  const gameCode = await join(host, "host");
  await join(guest, "guest", gameCode);
  return { host, guest, gameCode, barrier: (sock: ClientSocket) => join(sock, sock === host ? "host" : "guest", gameCode) };
}

/** Sends `count` `event`s from `sock` at once, then waits until the server has handled them all. */
async function flood(sock: ClientSocket, event: LimitedGameEvent, payload: unknown, count: number, barrier: (s: ClientSocket) => Promise<string>) {
  for (let i = 0; i < count; i++) sock.emit(event, payload);
  await barrier(sock);
}

/** FLOOD_FACTOR × burst `event`s at once: `target` (the handler's work) runs exactly `burst` times. */
async function expectFloodCapped(
  sock: ClientSocket, event: LimitedGameEvent, payload: unknown, target: MockInstance, barrier: (s: ClientSocket) => Promise<string>,
) {
  const { burst } = GAME_EVENT_LIMITS[event];
  await flood(sock, event, payload, FLOOD_FACTOR * burst, barrier);
  expect(target).toHaveBeenCalledTimes(burst);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("per-socket game event limits (EXP-062)", () => {
  it("im-ready", async () => {
    const { guest, barrier } = await lobby();
    const markReady = vi.spyOn(GameEngine.prototype, "markReady").mockImplementation(() => {});
    await expectFloodCapped(guest, "im-ready", undefined, markReady, barrier);
  });

  it("start-game", async () => {
    const { host, barrier } = await lobby();
    const startGame = vi.spyOn(GameEngine.prototype, "startGame").mockReturnValue(false);
    await expectFloodCapped(host, "start-game", undefined, startGame, barrier);
  });

  it("set-rounds", async () => {
    const { host, barrier } = await lobby();
    const setRounds = vi.spyOn(roomManager, "setRounds").mockReturnValue(false); // the room keeps DEFAULT_ROUNDS
    await expectFloodCapped(host, "set-rounds", { rounds: OTHER_ROUNDS }, setRounds, barrier);
  });

  it("set-rounds with the value the room already has is ignored (no rounds-updated)", async () => {
    const { host, guest, barrier } = await lobby();
    const setRounds = vi.spyOn(roomManager, "setRounds");
    let updates = 0;
    guest.on("rounds-updated", () => updates++);
    host.emit("set-rounds", { rounds: DEFAULT_ROUNDS });
    await barrier(host);
    await barrier(guest); // a broadcast sent while handling it would have reached the guest before this answer
    expect(setRounds).not.toHaveBeenCalled();
    expect(updates).toBe(0);
  });

  it("remove-player", async () => {
    const { host, barrier } = await lobby();
    const removePlayer = vi.spyOn(GameEngine.prototype, "removePlayer").mockReturnValue(undefined);
    await expectFloodCapped(host, "remove-player", { username: "ghost" }, removePlayer, barrier);
  });

  it("photo-sent", async () => {
    const { guest, gameCode, barrier } = await lobby();
    registerTurnUpload(gameCode, "guest", PHOTO, 1);
    const onPhoto = vi.spyOn(GameEngine.prototype, "onPhotoReceived").mockImplementation(() => {});
    await expectFloodCapped(guest, "photo-sent", { photo: PHOTO }, onPhoto, barrier);
  });

  it("photo-unavailable", async () => {
    const { guest, barrier } = await lobby();
    const onUnavailable = vi.spyOn(GameEngine.prototype, "onPhotoUnavailable").mockImplementation(() => {});
    await expectFloodCapped(guest, "photo-unavailable", { round: 1, attempt: 1 }, onUnavailable, barrier);
  });

  it("plant-photo", async () => {
    const { guest, gameCode, barrier } = await lobby();
    registerUpload(gameCode, "guest", PHOTO);
    const onPlanted = vi.spyOn(GameEngine.prototype, "onLatePlantedPhoto").mockImplementation(() => {});
    await expectFloodCapped(guest, "plant-photo", { photoUrl: PHOTO }, onPlanted, barrier);
  });

  describe("hold-end", () => {
    /** Makes the guest the photo owner, holding the scores screen (or not). */
    function setHolder(gameCode: string, held: boolean) {
      const room = roomManager.getRoom(gameCode)!;
      room.currentPlayer = room.players.find((p) => p.username === "guest")!;
      room.held = held;
    }

    it("releases from the socket holding are capped", async () => {
      const { guest, gameCode, barrier } = await lobby();
      setHolder(gameCode, true);
      const release = vi.spyOn(GameEngine.prototype, "handleRelease").mockReturnValue(false); // stays held
      await expectFloodCapped(guest, "hold-end", undefined, release, barrier);
    });

    it("is ignored without spending the bucket when the socket holds nothing, so a later release gets through", async () => {
      const { guest, gameCode, barrier } = await lobby();
      setHolder(gameCode, false);
      const release = vi.spyOn(GameEngine.prototype, "handleRelease").mockReturnValue(false);
      await flood(guest, "hold-end", undefined, FLOOD_FACTOR * GAME_EVENT_LIMITS["hold-end"].burst, barrier);
      expect(release).not.toHaveBeenCalled();

      setHolder(gameCode, true);
      guest.emit("hold-end");
      await barrier(guest);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("leave-room: once the bucket is spent, a leave from a rejoined room is dropped", async () => {
    const { host, guest, gameCode, barrier } = await lobby();
    let leftEvents = 0;
    host.on("player-left", () => leftEvents++);
    // The first leave removes the guest; the rest find no room but still spend the bucket
    for (let i = 0; i < GAME_EVENT_LIMITS["leave-room"].burst; i++) guest.emit("leave-room");
    await join(guest, "guest", gameCode); // handled after the leaves
    guest.emit("leave-room");
    await barrier(guest);
    await barrier(host); // a player-left sent while handling it would have reached the host before this answer
    expect(leftEvents).toBe(1);
    expect(roomManager.getRoom(gameCode)?.players.map((p) => p.username)).toEqual(["host", "guest"]);
  });

  it("each socket has its own buckets: a flood on one socket doesn't drop another player's event", async () => {
    const { host, guest, barrier } = await lobby();
    const markReady = vi.spyOn(GameEngine.prototype, "markReady").mockImplementation(() => {});
    await expectFloodCapped(guest, "im-ready", undefined, markReady, barrier);
    host.emit("im-ready");
    await barrier(host);
    expect(markReady).toHaveBeenCalledTimes(GAME_EVENT_LIMITS["im-ready"].burst + 1);
  });
});
