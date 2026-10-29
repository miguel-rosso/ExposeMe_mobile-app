import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine, PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { PLANTED_DELAY_MAX } from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-144: a photo wait resumed with little time left gets the same minimum on screen whether it is a normal or a
// planted round, so a game-resumed countdown can't tell them apart.

const REVEAL_TIME = 3_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PHOTO_RESUME_MIN_REMAINING = 5_000;
const PLANTED_PHOTO_MIN_LIFETIME = PHOTO_WAIT_TIMEOUT + ANSWER_TIME + REVEAL_TIME;
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const LEFT_AT_PAUSE = 2_000;

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;

function lobby(): Room {
  const r = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(r.gameCode, "bob", "sock-bob");
  rm.joinRoom(r.gameCode, "carol", "sock-carol");
  return r;
}

function start(plantedSlot?: number): void {
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  if (plantedSlot) room.plantedSlots = new Set([plantedSlot]);
  vi.advanceTimersByTime(GAME_START_DELAY);
}

/** alice and carol drop (bob alone: paused), stay away `ms`, then come back (resumed). */
function pauseFor(ms: number): void {
  for (const name of ["alice", "carol"]) {
    rm.markDisconnected(room.gameCode, name, player(name).socketId);
    engine.onConnectionChange(room);
  }
  expect(room.paused).toBe(true);
  vi.advanceTimersByTime(ms);
  for (const name of ["alice", "carol"]) {
    const p = player(name);
    expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-${Date.now()}`, p.rejoinToken)).toMatchObject({ success: true });
    engine.onPlayerRejoined(room, p);
  }
  expect(room.paused).toBe(false);
}

const lastResumed = () => events("game-resumed").pop()!.args[0];

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

describe("a photo wait resumed with less than PHOTO_RESUME_MIN_REMAINING left (EXP-144)", () => {
  it("normal round: game-resumed shows the minimum", () => {
    room = lobby();
    start();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - LEFT_AT_PAUSE);
    pauseFor(PAUSE_MIN_DURATION);
    expect(lastResumed()).toEqual({ phase: "waiting-photo", duration: PHOTO_RESUME_MIN_REMAINING, phaseTotal: PHOTO_WAIT_TIMEOUT });
  });

  it("planted round with no photo coming: game-resumed shows the same minimum, not the frozen countdown", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    // Drawn with just over its minimum lifetime left, then a long pause in the hidden delay makes it expire
    vi.advanceTimersByTime(UPLOAD_TTL_MS - PLANTED_PHOTO_MIN_LIFETIME - GAME_START_DELAY - 1);
    start(1);
    expect(events("your-turn")).toHaveLength(0);
    pauseFor(2 * 60_000);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX); // hidden delay over: photo expired, the countdown runs on
    expect(events("round-start")).toHaveLength(0);
    const snapshot = engine.snapshot(room);
    expect(snapshot.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(snapshot.duration - LEFT_AT_PAUSE);
    expect(events("round-skipped")).toHaveLength(0);

    pauseFor(PAUSE_MIN_DURATION);
    expect(lastResumed()).toEqual({ phase: "waiting-photo", duration: PHOTO_RESUME_MIN_REMAINING, phaseTotal: PHOTO_WAIT_TIMEOUT });
    // The skip comes when that countdown ends, as for an absent owner
    vi.advanceTimersByTime(PHOTO_RESUME_MIN_REMAINING - 1);
    expect(events("round-skipped")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    // A planted round has no owner: one room-wide announcement, without a reason (EXP-110)
    expect(events("round-skipped").map((e) => e.args[0])).toEqual([{ round: 1 }]);
  });
});

// A planted wait paused during its hidden delay: the photo comes after what the pause left of that delay, or after a
// quick re-send (PLANTED_RESEND_MIN..MAX, 100-400 ms) when little was left, like an owner re-sending a photo already
// uploaded. Never a fresh full upload-like delay.
describe("a planted wait resumed during its hidden delay", () => {
  const RESEND_AT_HALF = 100 + 0.5 * 300; // PLANTED_RESEND_MIN..MAX with Math.random() = 0.5

  /** Planted round 1 started (Math.random() = 0.5): its hidden delay. */
  function plantedRoundOne(): number {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    start(1);
    expect(room.currentPlayer).toBeNull();
    return room._timerDuration;
  }

  /** ms from now until the planted photo's round-start. */
  function untilRoundStart(): number {
    const t0 = Date.now();
    while (events("round-start").length === 0) vi.advanceTimersByTime(10);
    return Date.now() - t0;
  }

  it("little left of the delay: the photo comes after a quick re-send", () => {
    const delay = plantedRoundOne();
    vi.advanceTimersByTime(delay - 50);
    pauseFor(60_000);
    expect(untilRoundStart()).toBe(RESEND_AT_HALF);
  });

  it("much left of the delay: the photo comes when the rest of it is over", () => {
    const delay = plantedRoundOne();
    vi.advanceTimersByTime(100);
    pauseFor(60_000);
    expect(delay - 100).toBeGreaterThan(RESEND_AT_HALF);
    expect(untilRoundStart()).toBe(delay - 100);
  });
});
