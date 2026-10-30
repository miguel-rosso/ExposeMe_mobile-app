import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, ANSWER_TIME, GameEngine, HOLD_BUDGET_PER_ROUND, PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-214: the single phase timer of a room (armed per phase, frozen by a hold or a pause, re-armed with what was
// left). These pin the remaining time each path reads and the moment the re-armed timer fires.

const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const HOLD_MIN_REMAINING = 1_500;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;

/** alice + bob in round 1's answering phase; returns the owner and the other player. */
function answering(): { owner: Player; other: Player } {
  room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  const owner = room.currentPlayer!;
  engine.onPhotoReceived(room, PHOTO, owner.username);
  expect(room.phase).toBe("answering");
  return { owner, other: room.players.find((p) => p !== owner)! };
}

function drop(p: Player): void {
  rm.markDisconnected(room.gameCode, p.username, p.socketId);
  engine.onConnectionChange(room);
}

function rejoin(p: Player): void {
  expect(rm.joinRoom(room.gameCode, p.username, `${p.socketId}-r`, p.rejoinToken)).toMatchObject({ rejoin: true });
  engine.onPlayerRejoined(room, player(p.username));
}

/** The countdown a fresh snapshot shows now. */
const snapshotDuration = () => (engine.snapshot(room) as Omit<GameStateSnapshot, "yourGuess">).duration;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
});

afterEach(() => {
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("phase timer: remaining time and re-arm (EXP-214)", () => {
  it("a snapshot counts a running timer down and keeps a held one frozen, until the release re-arms it", () => {
    const { owner } = answering();
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + 1_000);
    expect(snapshotDuration()).toBe(SCORE_DISPLAY_TIME - 1_000);

    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(snapshotDuration()).toBe(SCORE_DISPLAY_TIME - 1_000);

    expect(engine.handleRelease(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(snapshotDuration()).toBe(SCORE_DISPLAY_TIME - 2_000);
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 2_000 - 1);
    expect(room.phase).toBe("scores");
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("waiting-photo");
  });

  it("a hold needs HOLD_MIN_REMAINING of the running scores timer", () => {
    const { owner } = answering();
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME - HOLD_MIN_REMAINING + 1);
    expect(engine.handleHold(room, owner.socketId)).toBe(false);
  });

  it("a second pause freezes what is left of the timer the first resume re-armed", () => {
    const { other } = answering();
    vi.advanceTimersByTime(2_000);
    drop(other);
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    rejoin(other);
    expect(room.paused).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(snapshotDuration()).toBe(ANSWER_TIME - 3_000 - ANSWER_GRACE);
    drop(player(other.username));
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    rejoin(player(other.username));
    const resumed = events("game-resumed").pop()!.args[0];
    expect(resumed).toMatchObject({ phase: "answering", duration: ANSWER_TIME - 3_000 - ANSWER_GRACE });

    vi.advanceTimersByTime(ANSWER_TIME - 3_000 - 1);
    expect(room.phase).toBe("answering");
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("reveal");
  });

  it("a pause ends a hold with hold-end before game-paused, and its budget timer no longer fires", () => {
    const { owner, other } = answering();
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + 1_000);
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    const from = emits.length;

    drop(other);
    expect(emits.slice(from).map((e) => e.event)).toEqual(["hold-end", "game-paused"]);
    vi.advanceTimersByTime(HOLD_BUDGET_PER_ROUND);
    expect(emits.slice(from).map((e) => e.event)).toEqual(["hold-end", "game-paused"]);
    expect(room.phase).toBe("scores");
  });
});
