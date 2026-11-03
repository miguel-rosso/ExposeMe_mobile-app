import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine, MAX_HOLDS_PER_ROUND } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Room, YourTurnData } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-329: what the engine keeps per game and what lives across a room's games. Each game starts clean when its first
// round is scheduled (hold limits, a planted wait cut short, the QA phase times), while the QA phase times outlive
// game over (late acks), and the photo request ids and the owners' photo waits carry over to the next game.

const GAME_START_DELAY = 1_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const ROUND_TIME = ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;
const lastTurn = () => events("your-turn").pop()!.args[0] as YourTurnData;

function createRoom(names: string[]): Room {
  const r = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  return r;
}

/** start-game and every player ready: the first round is scheduled (GAME_START_DELAY). */
function startAndReady(rounds: number): void {
  expect(engine.startGame(room)).toEqual({ ok: true });
  room.rounds = rounds;
  room.players.forEach((p) => engine.markReady(room, p));
}

/** The awaited owner sends their photo after `waitMs`, and the round plays out to its scores (or game over). */
function playRound(waitMs = 0): void {
  vi.advanceTimersByTime(waitMs);
  engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
  vi.advanceTimersByTime(ROUND_TIME);
}

/** leave-room as socketRoutes handles it. */
function leave(name: string): void {
  engine.removePlayer(room, name, "left");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
});

afterEach(() => {
  uploadStore.clear();
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("per-game engine state (EXP-329)", () => {
  it("QA phase times outlive game over (late acks) until the next game's first round is scheduled", () => {
    room = createRoom(["alice", "bob"]);
    startAndReady(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const scoresAt = Date.now();
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(events("game-over")).toHaveLength(1);
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBe(scoresAt);

    expect(engine.startGame(room)).toEqual({ ok: true });
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBe(scoresAt); // still in the ready phase
    room.players.forEach((p) => engine.markReady(room, p));
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBeUndefined();
  });

  it("hold limits are per game: holds used up in the last round don't carry into the next game's same round", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // alice owns every round
    room = createRoom(["alice", "bob"]);
    const alice = player("alice");
    startAndReady(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, "alice");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    for (let i = 0; i < MAX_HOLDS_PER_ROUND; i++) {
      expect(engine.handleHold(room, alice.socketId)).toBe(true);
      expect(engine.handleRelease(room, alice.socketId)).toBe(true);
    }
    expect(engine.handleHold(room, alice.socketId)).toBe(false); // this round's holds are used up
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(events("game-over")).toHaveLength(1);

    startAndReady(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, "alice");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room).toMatchObject({ phase: "scores", round: 1 });
    expect(engine.handleHold(room, alice.socketId)).toBe(true);
  });

  it("a planted photo wait cut short by game over isn't carried into the next game", () => {
    room = createRoom(["alice", "bob", "carol"]);
    const bob = player("bob");
    plantPhoto(room.gameCode, bob, PLANTED);
    startAndReady(3);
    room.plantedSlots = new Set([1]);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(engine.isPlanterOfCurrentWait(room, bob)).toBe(true);
    leave("alice");
    leave("carol"); // bob alone, nobody can come back: game over in the middle of the planted wait
    expect(events("game-over")).toHaveLength(1);

    rm.joinRoom(room.gameCode, "dave", "sock-dave");
    startAndReady(3);
    // Ready phase over, first round about to start: no planted wait in play, a boundary countdown
    expect(room.phase).toBe("waiting-photo");
    expect(engine.isPlanterOfCurrentWait(room, bob)).toBe(false);
    const snapshot = engine.snapshot(room);
    expect(snapshot.phaseTotal).toBe(snapshot.duration);
  });

  it("photo request ids keep counting across the room's games", () => {
    room = createRoom(["alice", "bob"]);
    startAndReady(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(lastTurn()).toEqual({ round: 1, attempt: 1 });
    playRound();
    expect(events("game-over")).toHaveLength(1);

    startAndReady(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(lastTurn()).toEqual({ round: 1, attempt: 2 });
  });

  it("an owner's photo waits shape their planted delay in the room's next game too", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // alice owns every round; draws take their first option
    room = createRoom(["alice", "bob", "carol"]);
    startAndReady(2);
    vi.advanceTimersByTime(GAME_START_DELAY);
    for (let round = 1; round <= 2; round++) {
      expect(room.currentPlayer?.username).toBe("alice");
      playRound(6_000);
    }
    expect(events("game-over")).toHaveLength(1);

    plantPhoto(room.gameCode, player("alice"), PLANTED);
    startAndReady(2);
    room.plantedSlots = new Set([1]);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.currentPlayer).toBeNull();
    const t0 = Date.now();
    while (!events("round-start").some((e) => (e.args[0] as { photo: string }).photo === PLANTED)) vi.advanceTimersByTime(10);
    // alice's 2 waits of 6 s from the last game (random() = 0: one of them, jitter factor 1 - 0.15), see plantedDelay.test
    expect(Date.now() - t0).toBe(6_000 * 0.85);
  });
});
