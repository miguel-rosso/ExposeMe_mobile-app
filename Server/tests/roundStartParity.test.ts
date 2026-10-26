import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-249 (EXP-126 / EXP-252): a planted round must be indistinguishable from a normal one. Normal and planted rounds
// share their photo-wait notice and their transition to answering, so this pins what both produce: the same
// room-wide events and payloads (photo aside), the same timers and the same round state.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PLANTED_DELAY = 2_000; // with Math.random() = 0 (no past waits in the room): the fixed distribution's median
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";

interface TimedEmit extends CapturedEmit { at: number }

let emits: TimedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const player = (name: string) => room.players.find((p) => p.username === name)!;

/** Room-wide events since the first waiting-photo, with the photo masked and times relative to that waiting-photo. */
function roomWideTimeline(): { event: string; args: unknown[]; after: number }[] {
  const wide = emits.filter((e) => e.target === room.gameCode && e.event !== "game-started");
  const t0 = wide[0].at;
  return wide.map((e) => ({
    event: e.event,
    args: e.args.map((a) => (a && typeof a === "object" && "photo" in a ? { ...a, photo: "<photo>" } : a)),
    after: e.at - t0,
  }));
}

/**
 * alice, bob, carol, `rounds` rounds; bob planted a photo for the last one when `planted`. Returns at round 1's
 * waiting-photo.
 */
function startOneRound(planted: boolean, rounds = 1): void {
  room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  rm.joinRoom(room.gameCode, "carol", "sock-carol");
  room.rounds = rounds;
  if (planted) plantPhoto(room.gameCode, player("bob"), PLANTED);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  if (planted) room.plantedSlots = new Set([rounds]); // force the planted slot
  room._consecutiveSkips = 2; // a successful round start resets the run of skipped rounds
  vi.advanceTimersByTime(GAME_START_DELAY);
}

/** Server clock of the room-wide `event` of `round`. */
function emittedAt(event: string, round: number): number | undefined {
  return emits.find((e) => e.target === room.gameCode && e.event === event && (e.args[0] as { round?: number }).round === round)?.at;
}

/** Round-start after `sendAfter` ms of photo wait: the owner sends their photo, or the planted delay runs out. */
function sendRoundPhoto(planted: boolean, sendAfter: number): Player {
  vi.advanceTimersByTime(sendAfter);
  const owner = planted ? player("bob") : room.currentPlayer!;
  if (!planted) engine.onPhotoReceived(room, PHOTO, owner.username);
  return owner;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fake = createFakeIo();
  emits = fake.emits as TimedEmit[];
  const push = emits.push.bind(emits);
  emits.push = (...items: CapturedEmit[]) => push(...items.map((e) => ({ ...e, at: Date.now() })));
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("normal and planted rounds start the same way (EXP-249)", () => {
  for (const planted of [false, true]) {
    const kind = planted ? "planted" : "uploaded";

    it(`${kind}: the waiting-photo notice and its round state`, () => {
      startOneRound(planted);
      const startedAt = Date.now();
      expect(room.phase).toBe("waiting-photo");
      expect(room.currentPhoto).toBeNull();
      expect(roomWideTimeline()).toEqual([
        { event: "waiting-photo", args: [{ round: 1, duration: PHOTO_WAIT_TIMEOUT }], after: 0 },
      ]);
      expect(engine.phaseEmittedAt(room, "waiting-photo", 1)).toBe(startedAt);
      // Nobody is told whose turn it is in a planted round; a normal owner alone gets your-turn
      const turns = emits.filter((e) => e.event === "your-turn");
      expect(turns.map((e) => e.target)).toEqual(planted ? [] : [room.currentPlayer!.socketId]);
    });

    it(`${kind}: round-start, its state and the answer timer up to round-reveal`, () => {
      startOneRound(planted);
      const owner = sendRoundPhoto(planted, PLANTED_DELAY);
      const roundStartAt = Date.now();

      expect(room).toMatchObject({ phase: "answering", round: 1, currentPhoto: planted ? PLANTED : PHOTO, _consecutiveSkips: 0 });
      expect(room.currentPlayer).toBe(owner);
      expect(room._timerDuration).toBe(ANSWER_TIME);
      expect(engine.phaseEmittedAt(room, "answering", 1)).toBe(roundStartAt);

      vi.advanceTimersByTime(ANSWER_TIME - 1);
      expect(room.phase).toBe("answering");
      vi.advanceTimersByTime(1);
      expect(room.phase).toBe("reveal");

      expect(roomWideTimeline()).toEqual([
        { event: "waiting-photo", args: [{ round: 1, duration: PHOTO_WAIT_TIMEOUT }], after: 0 },
        { event: "round-start", args: [{ photo: "<photo>", round: 1, duration: ANSWER_TIME - ANSWER_GRACE }], after: PLANTED_DELAY },
        { event: "round-reveal", args: [{ correctAnswer: owner.username, duration: REVEAL_TIME }], after: PLANTED_DELAY + ANSWER_TIME },
      ]);
    });
  }

  // Later rounds start from the scores phase (round 1 starts from the ready phase, already in waiting-photo): the
  // telemetry clock must still be stamped for the new phase
  for (const planted of [false, true]) {
    it(`${planted ? "planted" : "uploaded"} round 2: phaseEmittedAt matches its waiting-photo and round-start`, () => {
      startOneRound(planted, 2);
      sendRoundPhoto(false, PLANTED_DELAY); // round 1: alice's uploaded photo
      vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);

      expect(room.phase).toBe("waiting-photo");
      expect(emittedAt("waiting-photo", 2)).toBe(Date.now());
      expect(engine.phaseEmittedAt(room, "waiting-photo", 2)).toBe(emittedAt("waiting-photo", 2));

      sendRoundPhoto(planted, PLANTED_DELAY); // longer than the planted delay drawn from round 1's 2 s wait
      expect(room).toMatchObject({ phase: "answering", round: 2, currentPhoto: planted ? PLANTED : PHOTO });
      expect(emittedAt("round-start", 2)).toBeDefined();
      expect(engine.phaseEmittedAt(room, "answering", 2)).toBe(emittedAt("round-start", 2));
    });
  }

  it("only a planted round counts as a planted photo shown", () => {
    startOneRound(false);
    sendRoundPhoto(false, PLANTED_DELAY);
    expect(room.plantedPhotosShown).toBe(0);
    startOneRound(true);
    sendRoundPhoto(true, PLANTED_DELAY);
    expect(room.plantedPhotosShown).toBe(1);
  });
});
