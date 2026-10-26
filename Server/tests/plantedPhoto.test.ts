import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, GameEngine, PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { PLANTED_DELAY_MAX, TYPICAL_WAIT_MIN } from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto, receivedBy } from "./helpers";

// EXP-126: nobody can tell who planted a photo. No player payload says who planted one (nor who is ready, which
// gave the uploading planter away), a planted round shows the same sequence as a normal one (waiting-photo, then
// round-start after a realistic upload-like delay, no your-turn to anyone), and a planted photo is cleared
// once it is used.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PLANTED_DELAY_MIN = TYPICAL_WAIT_MIN;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;

/** alice (host), bob (planter), carol; round `slot` is bob's planted round (round 1: its waiting-photo already out). */
function plantedRoundOne(slot = 1): Room {
  const r = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(r.gameCode, "bob", "sock-bob");
  rm.joinRoom(r.gameCode, "carol", "sock-carol");
  const bob = r.players[1];
  plantPhoto(r.gameCode, bob, PLANTED);
  engine.startGame(r);
  r.players.forEach((p) => engine.markReady(r, p));
  r.plantedSlots = new Set([slot]); // force the planted slot
  vi.advanceTimersByTime(GAME_START_DELAY);
  return r;
}

function drop(name: string): void {
  const p = player(name);
  rm.markDisconnected(room.gameCode, name, p.socketId);
  engine.onConnectionChange(room);
}

function rejoin(name: string): Player {
  const p = player(name);
  expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-2`, p.rejoinToken)).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, p);
  return p;
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

describe("planted photos stay anonymous", () => {
  it("no public player shape says who planted a photo", () => {
    room = plantedRoundOne();
    for (const p of rm.publicPlayers(room)) {
      expect(p).not.toHaveProperty("hasPlantedPhoto");
      expect(p).not.toHaveProperty("isReady");
    }
    expect(rm.publicPlayer(player("bob"))).not.toHaveProperty("hasPlantedPhoto");
    const started = events("game-started")[0].args[0] as Record<string, unknown>[];
    for (const p of started) { expect(p).not.toHaveProperty("hasPlantedPhoto"); expect(p).not.toHaveProperty("isReady"); }
    const snap = engine.snapshot(room);
    for (const p of snap.players) { expect(p).not.toHaveProperty("hasPlantedPhoto"); expect(p).not.toHaveProperty("isReady"); }
  });

  it("a planted round shows waiting-photo, then round-start after an upload-like delay, with no your-turn", () => {
    room = plantedRoundOne();
    // Same room-wide waiting-photo as a normal round
    expect(events("waiting-photo")).toEqual([
      { target: room.gameCode, event: "waiting-photo", args: [{ round: 1, duration: PHOTO_WAIT_TIMEOUT }] },
    ]);
    expect(room.phase).toBe("waiting-photo");
    expect(events("your-turn")).toHaveLength(0);
    // The planter can't send a photo nor skip it meanwhile
    engine.onPhotoReceived(room, PHOTO, "bob");
    engine.onPhotoUnavailable(room, "bob", 1, 0);
    expect(events("round-skipped")).toHaveLength(0);

    vi.advanceTimersByTime(PLANTED_DELAY_MIN - 1);
    expect(events("round-start")).toHaveLength(0);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX - PLANTED_DELAY_MIN + 1);

    const starts = events("round-start");
    // One room-wide round-start, the planter included: not even bob is told it is his photo (EXP-252)
    expect(starts).toEqual([
      { target: room.gameCode, event: "round-start", args: [{ photo: PLANTED, round: 1, duration: ANSWER_TIME - ANSWER_GRACE }] },
    ]);
    expect(events("your-turn")).toHaveLength(0);
    expect(room.currentPlayer).toBe(player("bob"));
    expect(room.plantedPhotosShown).toBe(1);

    // Every player saw waiting-photo before round-start
    for (const p of room.players) {
      const seen = receivedBy(emits, p.socketId, room.gameCode).map((e) => e.event).filter((ev) => ev === "waiting-photo" || ev === "round-start");
      expect(seen).toEqual(["waiting-photo", "round-start"]);
    }
  });

  it("clears the planted photo and its flag once it is used", () => {
    room = plantedRoundOne();
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(player("bob").plantedPhoto).toBeUndefined();
    expect(player("bob").hasPlantedPhoto).toBeFalsy();
    // The rest of the game asks for photos normally
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(events("your-turn")).toHaveLength(1);
  });

  it("pauses and resumes in the planted pre-round window like a normal photo wait", () => {
    room = plantedRoundOne();
    drop("alice");
    drop("carol");
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(events("round-start")).toHaveLength(0);

    // Rejoin snapshot: a photo wait like any other (no photo, not the owner, a wait-sized countdown)
    rejoin("alice");
    const snap = emits.filter((e) => e.event === "game-state" && e.target === "sock-alice-2").pop()!.args[0] as GameStateSnapshot;
    expect(snap).toMatchObject({ phase: "waiting-photo", round: 0, photo: null, correctAnswer: null });
    expect(snap.duration).toBeGreaterThan(PLANTED_DELAY_MAX);
    expect(snap.duration).toBeLessThanOrEqual(PHOTO_WAIT_TIMEOUT);

    // bob + alice connected: resumes after the minimum pause, without your-turn to anyone
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    expect(room.paused).toBe(false);
    const resumed = events("game-resumed").pop()!.args[0] as { phase: string; duration: number };
    expect(resumed.phase).toBe("waiting-photo");
    // The countdown goes on from where the pause froze it: never more than the snapshot showed
    expect(resumed.duration).toBe(snap.duration);
    expect(events("your-turn")).toHaveLength(0);

    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(events("round-start").map((e) => (e.args[0] as { photo: string }).photo)).toEqual([PLANTED]);
    expect(events("waiting-photo")).toHaveLength(1);
  });

  it("the planter leaving in the window looks like an owner who left: another player is asked at once (EXP-029, DEC-035)", () => {
    /** Room-wide events (what every non-owner sees) with their time since `t0`. */
    const roomSeq = (t0: number, from: number) => emits.slice(from).filter((e) => e.target === room.gameCode)
      .map((e) => ({ event: e.event, args: e.args })).filter((e) => e.event !== "player-left");
    const times: Record<string, number[]> = { planted: [], normal: [] };

    // Planted round, bob leaves during the hidden delay
    room = plantedRoundOne();
    let t0 = Date.now();
    rm.removePlayer(room.gameCode, "bob");
    engine.onConnectionChange(room);
    const timeline = (key: string, from: number) => {
      for (let t = 0; t <= PHOTO_WAIT_TIMEOUT; t += 250) {
        if (emits.slice(from).filter((e) => e.event === "waiting-photo" && e.target === room.gameCode).length > 1) break;
        vi.advanceTimersByTime(250);
      }
      times[key].push(Date.now() - t0);
    };
    timeline("planted", 0);
    const planted = roomSeq(t0, 0);
    expect(events("round-start")).toHaveLength(0);
    // The planted photo left with its planter: a connected player is asked for round 1's photo
    const plantedTurns = events("your-turn").map((e) => e.args[0]);
    expect(["alice", "carol"]).toContain(room.currentPlayer?.username);

    // Normal round, the picked owner leaves at once
    const fake = createFakeIo();
    emits = fake.emits;
    rm = new RoomManager();
    engine = new GameEngine(fake.io, rm);
    room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.joinRoom(room.gameCode, "carol", "sock-carol");
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    t0 = Date.now();
    rm.removePlayer(room.gameCode, room.currentPlayer!.username);
    engine.onConnectionChange(room);
    timeline("normal", 0);
    const normal = roomSeq(t0, 0);
    // The new owner's request is numbered the same way: one attempt per waiting-photo, the planted one included (S4)
    expect(events("your-turn").map((e) => e.args[0]).slice(1)).toEqual(plantedTurns);
    expect(plantedTurns).toEqual([{ round: 1, attempt: 2 }]);

    // Same room-wide sequence: game-started, waiting-photo, then right away a new waiting-photo for the same round
    const shape = (seq: { event: string; args: unknown[] }[]) => seq.map((e) => e.event === "game-started" ? e.event : JSON.stringify(e));
    expect(shape(planted)).toEqual(shape(normal));
    expect(planted.map((e) => e.event)).toEqual(["game-started", "waiting-photo", "waiting-photo"]);
    expect(planted[2].args[0]).toEqual({ round: 1, duration: PHOTO_WAIT_TIMEOUT });
    expect(times.planted[0]).toBe(times.normal[0]);
    expect(times.normal[0]).toBe(0);
  });

  // How long the hidden delay lasts (realistic, and like the room's own real waits): plantedDelay.test.ts

  it("game over in the window: no round-start, the snapshot shows no countdown", () => {
    room = plantedRoundOne();
    rm.removePlayer(room.gameCode, "alice");
    engine.onConnectionChange(room);
    rm.removePlayer(room.gameCode, "carol");
    engine.onConnectionChange(room);
    expect(events("game-over")).toHaveLength(1);
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(events("round-start")).toHaveLength(0);
    expect(engine.snapshot(room)).toMatchObject({ started: false, phase: null, duration: 0 });
  });

  it("a planted photo that arrives after the draw (app retry after im-ready) still gets a later round", () => {
    room = plantedRoundOne();
    plantPhoto(room.gameCode, player("carol"), PHOTO);
    expect(room.plantedSlots.size).toBe(0); // bob's slot (round 1) is already in its wait
    engine.onLatePlantedPhoto(room);
    expect(room.plantedSlots.size).toBe(1);
    const late = [...room.plantedSlots][0];
    expect(late).toBeGreaterThanOrEqual(2);
    expect(late).toBeLessThanOrEqual(room.rounds);
    engine.onLatePlantedPhoto(room); // once per photo
    expect(room.plantedSlots.size).toBe(1);
  });
});
