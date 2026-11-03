import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Room, WaitingPhotoData } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-318: every game run in a room gets its own number (1, 2, ... ; 0 before the first one), sent in game-started,
// waiting-photo and game-state, so the app tells exactly whether a rejoin snapshot is of the game its screen shows or
// of the next one, however early the first one ended.

const GAME_START_DELAY = 1_000;

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;
const lastSnapshotFor = (name: string) =>
  events("game-state").filter((e) => e.target === `sock-${name}`).pop()!.args[0] as GameStateSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  roomManager = new RoomManager();
  engine = new GameEngine(fake.io, roomManager);
  room = roomManager.createRoom("alice", "sock-alice");
  roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Starts a game with everyone ready and lets its first photo wait go out. */
function startToFirstWait(): void {
  expect(engine.startGame(room)).toEqual({ ok: true });
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
}

describe("game number (EXP-318)", () => {
  it("is 0 in a room that played no game yet, also in its lobby snapshot", () => {
    expect(room.gameNumber).toBe(0);
    engine.markReady(room, player("bob")); // not started: answered with the room's snapshot
    expect(lastSnapshotFor("bob")).toMatchObject({ started: false, gameNumber: 0 });
  });

  it("goes up by one with every game started, and is in game-started, waiting-photo and game-state", () => {
    startToFirstWait();
    expect(events("game-started")[0].args).toEqual([expect.any(Array), room.rounds, 1]);
    expect(events("waiting-photo")[0].args[0]).toEqual<WaitingPhotoData>({ round: 1, duration: expect.any(Number), gameNumber: 1 });
    engine.resendState(room, player("bob"));
    expect(lastSnapshotFor("bob")).toMatchObject({ started: true, phase: "waiting-photo", gameNumber: 1 });

    // The first game ends on a leave during its first photo wait; a new player joins and the host starts again
    engine.removePlayer(room, "bob", "left");
    expect(events("game-over")).toHaveLength(1);
    roomManager.joinRoom(room.gameCode, "carol", "sock-carol");
    emits.length = 0;
    startToFirstWait();
    expect(events("game-started")[0].args[2]).toBe(2);
    expect((events("waiting-photo")[0].args[0] as WaitingPhotoData).gameNumber).toBe(2);
    engine.resendState(room, player("carol"));
    expect(lastSnapshotFor("carol")).toMatchObject({ started: true, round: 0, gameNumber: 2 });
  });

  it("a game-over snapshot carries the number of the game that ended", () => {
    startToFirstWait();
    engine.removePlayer(room, "bob", "left");
    engine.markReady(room, player("alice")); // a game screen that missed the game-over
    expect(lastSnapshotFor("alice")).toMatchObject({ started: false, gameNumber: 1 });
  });

  it("a refused start (fewer than 2 players) does not use a number", () => {
    engine.removePlayer(room, "bob", "left");
    expect(engine.startGame(room)).toEqual({ ok: false, reason: "not-enough-players", removed: [] });
    expect(room.gameNumber).toBe(0);
  });
});
