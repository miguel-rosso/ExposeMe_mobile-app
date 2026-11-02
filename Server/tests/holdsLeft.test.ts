import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine, HOLD_BUDGET_PER_ROUND, MAX_HOLDS_PER_ROUND } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, HoldEndData, Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-176: every hold-end and the game-state snapshot tell how many holds the photo owner can still start this round
// (`holdsLeft`), 0 once the count or the time budget is used up, so the app can grey out its hold button instead of
// guessing.

const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const HOLD_MIN_REMAINING = 1_500;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg"; // shape of a POST /upload result

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;
let owner: Player;
let others: Player[];

const events = (name: string) => emits.filter((e) => e.event === name);
const holdEnds = () => events("hold-end").map((e) => e.args[0] as HoldEndData);
const lastSnapshot = () => events("game-state").pop()!.args[0] as GameStateSnapshot;

/** 3 players, round 1's scores of the owner's photo. */
function scoresRoom(): void {
  room = rm.createRoom("alice", "sock-alice");
  for (const n of ["bob", "carol"]) rm.joinRoom(room.gameCode, n, `sock-${n}`);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  owner = room.currentPlayer!;
  others = room.players.filter((p) => p !== owner);
  engine.onPhotoReceived(room, PHOTO, owner.username);
  vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
  expect(room.phase).toBe("scores");
}

function holdFor(ms: number): void {
  expect(engine.handleHold(room, owner.socketId)).toBe(true);
  vi.advanceTimersByTime(ms);
  if (room.held) expect(engine.handleRelease(room, owner.socketId)).toBe(true);
}

/** Rejoin on a new socket, as socketRoutes handles it. */
function rejoin(p: Player): void {
  rm.joinRoom(room.gameCode, p.username, `${p.socketId}-2`, p.rejoinToken);
  engine.onPlayerRejoined(room, p);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
  scoresRoom();
});

afterEach(() => {
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("holdsLeft (EXP-176)", () => {
  it("each release's hold-end counts down the holds left, to 0 at the last one", () => {
    for (let i = 0; i < MAX_HOLDS_PER_ROUND; i++) holdFor(100);

    expect(holdEnds()).toEqual([{ holdsLeft: 2 }, { holdsLeft: 1 }, { holdsLeft: 0 }]);
    expect(events("hold-end").every((e) => e.target === room.gameCode)).toBe(true);
    expect(engine.handleHold(room, owner.socketId)).toBe(false);
  });

  it("a release sends hold-resume, then exactly one hold-end", () => {
    holdFor(100);
    const order = emits.map((e) => e.event).filter((e) => e === "hold-end" || e === "hold-resume");
    expect(order).toEqual(["hold-resume", "hold-end"]);
  });

  it("a hold force-released at the end of the budget says 0, though fewer holds were started", () => {
    holdFor(HOLD_BUDGET_PER_ROUND);

    expect(holdEnds()).toEqual([{ holdsLeft: 0 }]);
  });

  it("says 0 once less of the budget is left than a hold needs", () => {
    holdFor(HOLD_BUDGET_PER_ROUND - HOLD_MIN_REMAINING + 1);

    expect(holdEnds()).toEqual([{ holdsLeft: 0 }]);
    expect(engine.handleHold(room, owner.socketId)).toBe(false);
  });

  // EXP-291: the last HOLD_MIN_REMAINING of the scoreboard is too little for a hold; holdsLeft and handleHold agree
  it("with less than HOLD_MIN_REMAINING of the scoreboard left, the snapshot says 0 and no hold is accepted", () => {
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - HOLD_MIN_REMAINING + 1);

    rejoin(others[0]);
    expect(lastSnapshot()).toMatchObject({ phase: "scores", holdsLeft: 0 });
    expect(engine.handleHold(room, owner.socketId)).toBe(false);
  });

  it("a hold started at that point is released with the holds still counted (the scoreboard was frozen)", () => {
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - HOLD_MIN_REMAINING);
    holdFor(100);

    expect(events("hold-resume").pop()!.args[0]).toMatchObject({ duration: HOLD_MIN_REMAINING });
    expect(holdEnds()).toEqual([{ holdsLeft: 2 }]);
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
  });

  it("in the next photo wait the snapshot still tells the last round's holds (the app has no button there)", () => {
    holdFor(HOLD_BUDGET_PER_ROUND);
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(room.phase).toBe("waiting-photo");

    rejoin(others[0]);
    expect(lastSnapshot()).toMatchObject({ phase: "waiting-photo", holdsLeft: 0 });
  });

  it("a hold ended by a pause tells what is left too", () => {
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    for (const p of others) {
      rm.markDisconnected(room.gameCode, p.username, p.socketId);
      engine.onConnectionChange(room, p);
    }

    expect(room.paused).toBe(true);
    expect(holdEnds()).toEqual([{ holdsLeft: 2 }]);
  });

  it("the game-state snapshot carries the holds left of the round in play, all of them in the next round", () => {
    rejoin(others[0]);
    expect(lastSnapshot().holdsLeft).toBe(MAX_HOLDS_PER_ROUND);

    holdFor(100);
    rejoin(others[0]);
    expect(lastSnapshot().holdsLeft).toBe(MAX_HOLDS_PER_ROUND - 1);

    holdFor(HOLD_BUDGET_PER_ROUND);
    rejoin(others[0]);
    expect(lastSnapshot().holdsLeft).toBe(0);

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    rejoin(others[0]);
    expect(lastSnapshot()).toMatchObject({ phase: "answering", holdsLeft: MAX_HOLDS_PER_ROUND });
  });
});
