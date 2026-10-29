import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine } from "../managers/GameEngine";
import {
  drawPlantedDelay, PhotoWaitHistory, TYPICAL_WAIT_MAX, TYPICAL_WAIT_MEDIAN, TYPICAL_WAIT_MIN, typicalPhotoWait, WAITS_PER_PLAYER,
} from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-146: a planted round's hidden delay is drawn from a fixed distribution of realistic photo waits, mixed only with
// the planter's own real waits in the room (their latest few). Other rooms, other players and players who left can't
// shift it, and right after a server start it isn't a recognisable fixed range either.

const GAME_START_DELAY = 1_000;
const MAX_DELAY = 14_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const ROUND_TIME = ANSWER_TIME + 3_000 + 5_000; // answering, reveal, scores

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let roomSeq = 0;

const events = (name: string) => emits.filter((e) => e.event === name);

/** A started room of alice, bob and carol, first photo wait under way (round `plantedSlot` planted by `planter`). */
function startedRoom(plantedSlot?: number, planter = "bob"): Room {
  const room = rm.createRoom("alice", `sock-alice-${++roomSeq}`);
  rm.joinRoom(room.gameCode, "bob", `sock-bob-${room.gameCode}`);
  rm.joinRoom(room.gameCode, "carol", `sock-carol-${room.gameCode}`);
  if (plantedSlot) plantPhoto(room.gameCode, room.players.find((p) => p.username === planter)!, PLANTED);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  if (plantedSlot) room.plantedSlots = new Set([plantedSlot]);
  vi.advanceTimersByTime(GAME_START_DELAY);
  return room;
}

/** A fixed sequence of "random" values, repeated. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

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

describe("planted delay (EXP-146)", () => {
  it("other rooms can't shift a room's planted delay", () => {
    // Other rooms: every owner sends their photo after 13.9 s, round after round
    for (let i = 0; i < 20; i++) {
      const other = startedRoom();
      vi.advanceTimersByTime(13_900);
      engine.onPhotoReceived(other, PHOTO, other.currentPlayer!.username);
      rm.deleteRoom(other.gameCode);
    }

    // Fresh rooms whose first round is planted: only the fixed distribution applies
    for (let i = 0; i < 10; i++) {
      const before = events("round-start").length;
      const room = startedRoom(1);
      const t0 = Date.now();
      while (events("round-start").length === before) vi.advanceTimersByTime(50);
      const delay = Date.now() - t0;
      expect(delay).toBeGreaterThanOrEqual(TYPICAL_WAIT_MIN);
      expect(delay).toBeLessThanOrEqual(TYPICAL_WAIT_MAX + 50);
      rm.deleteRoom(room.gameCode);
    }
  });

  it("right after a start, delays spread over a realistic range (not the old fixed 1-3 s)", () => {
    const draws = Array.from({ length: 2_000 }, () => drawPlantedDelay([], MAX_DELAY));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(TYPICAL_WAIT_MIN);
    expect(Math.max(...draws)).toBeLessThanOrEqual(TYPICAL_WAIT_MAX);
    const share = (pred: (ms: number) => boolean) => draws.filter(pred).length / draws.length;
    expect(share((ms) => ms < 1_000)).toBeGreaterThan(0.01);
    expect(share((ms) => ms > 3_000)).toBeGreaterThan(0.1);
    expect(share((ms) => ms >= 1_000 && ms <= 3_000)).toBeLessThan(0.9);
  });

  it("the fixed distribution is centred on its median and clamped", () => {
    expect(typicalPhotoWait(sequence(0, 0))).toBe(2_000); // a normal value of 0: the median
    expect(typicalPhotoWait(sequence(1 - 1e-12, 0))).toBe(TYPICAL_WAIT_MAX);
    expect(typicalPhotoWait(sequence(1 - 1e-12, 0.5))).toBe(TYPICAL_WAIT_MIN);
  });

  it("the planter's own waits take over as they come in", () => {
    const waits = [6_000, 6_000, 6_000];
    // 3 own waits against a weight of 4: an own wait is drawn when random() < 3/7 (jitter 0 at 0.5)
    expect(drawPlantedDelay(waits, MAX_DELAY, sequence(0.2, 0.5, 0.5))).toBe(6_000);
    expect(drawPlantedDelay(waits, MAX_DELAY, sequence(0.9, 0, 0))).toBe(TYPICAL_WAIT_MEDIAN); // the fixed distribution
  });

  /** alice owns rounds 1-2 (Math.random() = 0 picks the first candidate) and sends after 6 s; round 3 is planted. */
  function plantedAfterAlicesWaits(planter: string): number {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const room = startedRoom(3, planter);
    for (let round = 1; round <= 2; round++) {
      expect(room.currentPlayer?.username).toBe("alice");
      vi.advanceTimersByTime(6_000);
      engine.onPhotoReceived(room, PHOTO, "alice");
      vi.advanceTimersByTime(ROUND_TIME);
    }
    expect(room.currentPlayer).toBeNull();
    const t0 = Date.now();
    while (!events("round-start").some((e) => (e.args[0] as { photo: string }).photo === PLANTED)) vi.advanceTimersByTime(10);
    return Date.now() - t0;
  }

  it("the planter's own uploads are imitated", () => {
    // alice's 2 waits against a weight of 4 (random() = 0 draws one): 6 s with a jitter factor of 1 - 0.15
    expect(plantedAfterAlicesWaits("alice")).toBe(6_000 * 0.85);
  });

  it("other players' waits don't shape the planter's delay", () => {
    // bob has no waits of his own: the fixed distribution (random() = 0: its median)
    expect(plantedAfterAlicesWaits("bob")).toBe(TYPICAL_WAIT_MEDIAN);
  });

  it("a player who leaves takes their waits along: a newcomer with the same name starts with none", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the first connected candidate is picked: alice
    const room = startedRoom();
    room.rounds = 2;
    for (let round = 1; round <= 2; round++) {
      expect(room.currentPlayer?.username).toBe("alice");
      vi.advanceTimersByTime(6_000);
      engine.onPhotoReceived(room, PHOTO, "alice");
      vi.advanceTimersByTime(ROUND_TIME);
    }
    expect(events("game-over")).toHaveLength(1);

    // alice leaves the lobby (as socketRoutes handles it) and someone else joins as "alice" right away
    rm.removePlayer(room.gameCode, "alice");
    engine.onConnectionChange(room);
    expect(rm.joinRoom(room.gameCode, "alice", "sock-new-alice")).toMatchObject({ success: true });
    const newcomer = room.players.find((p) => p.username === "alice")!;
    plantPhoto(room.gameCode, newcomer, PLANTED);
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    room.plantedSlots = new Set([1]);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.currentPlayer).toBeNull();
    const t0 = Date.now();
    while (!events("round-start").some((e) => (e.args[0] as { photo: string }).photo === PLANTED)) vi.advanceTimersByTime(10);
    // The newcomer has no waits: the fixed distribution (random() = 0: its median), not the leaver's 6 s
    expect(Date.now() - t0).toBe(TYPICAL_WAIT_MEDIAN);
  });
});

describe("PhotoWaitHistory (one room)", () => {
  it("keeps each player's latest waits only, at most TYPICAL_WAIT_MAX each", () => {
    const history = new PhotoWaitHistory();
    for (let i = 0; i < WAITS_PER_PLAYER; i++) history.record("alice", 1_000);
    history.record("alice", 14_000); // drops alice's oldest; a wait this long counts as TYPICAL_WAIT_MAX
    expect(history.of("alice")).toEqual([1_000, 1_000, TYPICAL_WAIT_MAX]);
    expect(history.of("bob")).toEqual([]);
  });

  it("forgets players who left (their name may come back as someone else)", () => {
    const history = new PhotoWaitHistory();
    history.record("alice", 2_000);
    history.record("bob", 3_000);
    history.keepOnly(["bob"]);
    expect(history.of("alice")).toEqual([]);
    expect(history.of("bob")).toEqual([3_000]);
  });
});
