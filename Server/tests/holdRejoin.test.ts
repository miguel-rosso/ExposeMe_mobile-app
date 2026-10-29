import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, HOLD_BUDGET_PER_ROUND, MAX_HOLDS_PER_ROUND } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-299: a rejoin force-releases a hold only when the rejoiner is the photo owner holding the scores screen.
// Anyone else's rejoin leaves the hold alone, and an owner's rejoin with no hold active changes nothing.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg"; // shape of a POST /upload result

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const holdEvents = () => emits.filter((e) => e.event === "hold-end" || e.event === "hold-resume");

/** 3 players, first round answering the owner's photo. */
function answeringRoom(): { owner: Player; others: Player[] } {
  room = rm.createRoom("alice", "sock-alice");
  for (const n of ["bob", "carol"]) rm.joinRoom(room.gameCode, n, `sock-${n}`);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  const owner = room.currentPlayer!;
  engine.onPhotoReceived(room, PHOTO, owner.username);
  expect(room.phase).toBe("answering");
  return { owner, others: room.players.filter((p) => p !== owner) };
}

/** Rejoin on a new socket while the old one is still open, as socketRoutes handles it. */
function rejoin(p: Player): void {
  const res = rm.joinRoom(room.gameCode, p.username, `${p.socketId}-2`, p.rejoinToken);
  expect(res).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, p);
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
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a rejoin and the scores hold (EXP-299)", () => {
  it("another player's rejoin leaves the owner's hold in place", () => {
    const { owner, others } = answeringRoom();
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
    expect(engine.handleHold(room, owner.socketId)).toBe(true);

    rejoin(others[0]);

    expect(room.held).toBe(true);
    expect(holdEvents()).toHaveLength(0);
    expect(events("game-state").pop()!.args[0]).toMatchObject({ phase: "scores", held: true });
  });

  it("the owner's rejoin with no hold active sends no hold events and leaves the round's hold budget whole", () => {
    const { owner } = answeringRoom();
    vi.advanceTimersByTime(2_000);

    rejoin(owner);

    expect(holdEvents()).toHaveLength(0);
    // The answering timer runs on untouched
    vi.advanceTimersByTime(ANSWER_TIME - 2_000 - 1);
    expect(events("round-reveal")).toHaveLength(0);
    vi.advanceTimersByTime(1 + REVEAL_TIME);
    expect(room.phase).toBe("scores");

    // Every hold of the round and its whole budget are still there
    for (let i = 1; i < MAX_HOLDS_PER_ROUND; i++) {
      expect(engine.handleHold(room, owner.socketId)).toBe(true);
      expect(engine.handleRelease(room, owner.socketId)).toBe(true);
    }
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(HOLD_BUDGET_PER_ROUND - 1);
    expect(room.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(room.held).toBe(false);
  });
});
