import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-223: the engine remembers when it broadcast each phase, so a qa-ack can be recorded with the server emit time
// (`serverAt`) next to the device times. EXP-266: a slow phone acks a phase after the next one was broadcast, so the
// times of the current and the previous round are kept. Fake timers: the clock stands still while a timer callback
// emits, so Date.now() right after it fired is the emit time.

const GAME_START_DELAY = 1_000;
const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const PHOTO = "https://example.invalid/photo.jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;

const emitted = (event: string) => emits.some((e) => e.event === event);

/** alice (host) and bob, both ready; round `plantedSlot` (if any) is bob's planted photo. */
function readyRoom(plantedSlot?: number): Room {
  const room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  if (plantedSlot) plantPhoto(room.gameCode, room.players[1], PLANTED);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  room.plantedSlots = new Set(plantedSlot ? [plantedSlot] : []);
  return room;
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("phaseEmittedAt", () => {
  it("is the server time of each phase broadcast of the round, also once a later phase was broadcast", () => {
    const room = readyRoom();
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBeUndefined(); // nothing broadcast yet

    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(emitted("waiting-photo")).toBe(true);
    const waitingAt = Date.now();
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBe(waitingAt);

    vi.advanceTimersByTime(500);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const answeringAt = Date.now();
    expect(engine.phaseEmittedAt(room, "answering", 1)).toBe(answeringAt);
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBe(waitingAt); // a late ack still gets its time

    vi.advanceTimersByTime(ANSWER_TIME);
    expect(emitted("round-reveal")).toBe(true);
    const revealAt = Date.now();
    expect(engine.phaseEmittedAt(room, "reveal", 1)).toBe(revealAt);

    vi.advanceTimersByTime(REVEAL_TIME);
    expect(emitted("round-scores")).toBe(true);
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBe(Date.now());
    expect(engine.phaseEmittedAt(room, "reveal", 1)).toBe(revealAt);
    expect(engine.phaseEmittedAt(room, "answering", 1)).toBe(answeringAt);
    expect(engine.phaseEmittedAt(room, "scores", 2)).toBeUndefined(); // not broadcast yet
  });

  it("keeps the previous round's times through the next round, then drops them", () => {
    const room = readyRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const scores1At = Date.now();

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME); // round 2's photo wait
    expect(engine.phaseEmittedAt(room, "waiting-photo", 2)).toBe(Date.now());
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBe(scores1At); // round 1's scores ack, late
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBe(scores1At);

    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME); // round 3's photo wait
    expect(engine.phaseEmittedAt(room, "waiting-photo", 3)).toBe(Date.now());
    expect(engine.phaseEmittedAt(room, "scores", 2)).toBeDefined();
    expect(engine.phaseEmittedAt(room, "scores", 1)).toBeUndefined(); // two rounds back: dropped
  });

  it("has none for a phase broadcast twice in the same round (a skipped photo wait): a late ack can't be matched", () => {
    const room = readyRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
    const firstWait = Date.now();
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBe(firstWait);
    vi.advanceTimersByTime(500);
    const turns = emits.filter((e) => e.event === "your-turn");
    const turn = turns[turns.length - 1].args[0] as { round: number; attempt: number };
    engine.onPhotoUnavailable(room, room.currentPlayer!.username, turn.round, turn.attempt);
    expect(emits.filter((e) => e.event === "waiting-photo")).toHaveLength(2); // round 1 again
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBeUndefined();

    // The next phase is unambiguous again
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    expect(engine.phaseEmittedAt(room, "answering", 1)).toBe(Date.now());
  });

  it("covers a planted round's waiting-photo and round-start", () => {
    const room = readyRoom(1);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBe(Date.now());
    vi.advanceTimersToNextTimer(); // the planted photo's upload-like delay
    expect(emitted("round-start")).toBe(true);
    expect(engine.phaseEmittedAt(room, "answering", 1)).toBe(Date.now());
  });
});
