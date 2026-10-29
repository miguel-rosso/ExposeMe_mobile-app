import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine, PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { GameStateSnapshot, PhaseResumeData, Player, Room, RoundPhase } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-273: game-state, game-resumed and hold-resume carry `phaseTotal`, the full countdown the phase's start event
// sent (`duration` of waiting-photo / round-start / round-reveal / round-scores), so a client that reconnects into a
// phase it never saw start draws its bar from where the phase is instead of from empty. Pauses and holds never change
// it; before any start event (ready phase, round boundary) the countdown is whole: phaseTotal = duration.

const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const AWAY = 1_000;
const BEFORE_PLANTED_PHOTO = 500; // shorter than any planted delay (TYPICAL_WAIT_MIN)

const START_EVENTS: Record<RoundPhase, string> = {
  "waiting-photo": "waiting-photo",
  answering: "round-start",
  reveal: "round-reveal",
  scores: "round-scores",
};

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const lastPayload = <T>(name: string) => events(name).pop()!.args[0] as T;
const player = (name: string) => room.players.find((p) => p.username === name)!;
/** `duration` of the event that started `phase` most recently: what a client that saw the start drew. */
const startDuration = (phase: RoundPhase) => lastPayload<{ duration: number }>(START_EVENTS[phase]).duration;

function lobby(names = ["alice", "bob", "carol"]): Room {
  const r = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  return r;
}

/** Started game, first photo awaited (`plantedSlot`: that round is planted). */
function start(plantedSlot?: number): void {
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  if (plantedSlot) room.plantedSlots = new Set([plantedSlot]);
  vi.advanceTimersByTime(GAME_START_DELAY);
}

function drop(name: string): void {
  rm.markDisconnected(room.gameCode, name, player(name).socketId);
  engine.onConnectionChange(room);
}

function rejoin(name: string): Player {
  const p = player(name);
  expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-${Date.now()}`, p.rejoinToken)).toMatchObject({ success: true });
  engine.onPlayerRejoined(room, p);
  return p;
}

function snapshotFor(p: Player): GameStateSnapshot {
  return emits.filter((e) => e.event === "game-state" && e.target === p.socketId).pop()!.args[0] as GameStateSnapshot;
}

/** Someone who isn't the round's owner (a planted round has none). */
const notOwner = () => room.players.find((p) => p !== room.currentPlayer)!.username;

/** A new engine and room manager, nothing emitted yet. */
function resetEngine(): void {
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  resetEngine();
});

afterEach(() => {
  uploadStore.clear();
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("game-state phaseTotal (rejoin into a phase not seen from its start)", () => {
  // Phase reached `into` ms after the round's photo arrived, with time already gone in it
  const PHASES: [RoundPhase, number][] = [
    ["answering", 2_000],
    ["reveal", ANSWER_TIME + 1_000],
    ["scores", ANSWER_TIME + REVEAL_TIME + 2_000],
  ];

  it.each(PHASES)("%s: phaseTotal is the phase's start duration, duration what is left", (phase, into) => {
    room = lobby();
    start();
    const away = notOwner();
    drop(away); // 2 still connected: the game goes on without them
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(into);
    expect(room.phase).toBe(phase);

    const snap = snapshotFor(rejoin(away));
    expect(snap.phase).toBe(phase);
    expect(snap.phaseTotal).toBe(startDuration(phase));
    expect(snap.duration).toBeLessThan(snap.phaseTotal);
  });

  it.each([["normal", false], ["planted", true]])("waiting-photo of a %s round: phaseTotal is the waiting-photo duration", (_kind, planted) => {
    room = lobby();
    if (planted) plantPhoto(room.gameCode, player("bob"), PLANTED);
    start(planted ? 1 : undefined);
    expect(room.currentPlayer === null).toBe(planted);
    const away = notOwner();
    drop(away);
    vi.advanceTimersByTime(BEFORE_PLANTED_PHOTO);

    const snap = snapshotFor(rejoin(away));
    expect(snap).toMatchObject({ phase: "waiting-photo", phaseTotal: PHOTO_WAIT_TIMEOUT, duration: PHOTO_WAIT_TIMEOUT - BEFORE_PLANTED_PHOTO });
    expect(snap.phaseTotal).toBe(startDuration("waiting-photo"));
  });

  it("ready phase: nothing started yet, phaseTotal = duration", () => {
    room = lobby();
    engine.startGame(room);
    const snap = engine.snapshot(room);
    expect(snap.phase).toBeNull();
    expect(snap.phaseTotal).toBe(snap.duration);
  });

  it("game over: 0, like duration", () => {
    room = lobby();
    expect(engine.snapshot(room)).toMatchObject({ started: false, duration: 0, phaseTotal: 0 });
  });
});

describe("game-resumed phaseTotal (pauses never change it)", () => {
  /** alice and carol drop (bob alone: paused), stay away, then alice comes back (resumed). */
  function pauseAndResume(): void {
    drop("alice");
    drop("carol");
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    rejoin("alice");
    expect(room.paused).toBe(false);
  }

  it.each(["answering", "reveal", "scores"] as RoundPhase[])("%s: the phase's start duration", (phase) => {
    room = lobby();
    start();
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    while (room.phase !== phase) vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(AWAY);
    pauseAndResume();

    const resumed = lastPayload<PhaseResumeData>("game-resumed");
    expect(resumed.phase).toBe(phase);
    expect(resumed.phaseTotal).toBe(startDuration(phase));
    expect(resumed.duration).toBeLessThan(resumed.phaseTotal);
    // The rejoiner's snapshot right after says the same
    expect(snapshotFor(player("alice"))).toMatchObject({ phase, phaseTotal: resumed.phaseTotal, duration: resumed.duration });
  });

  it("waiting-photo resumed with the minimum: still the waiting-photo duration", () => {
    room = lobby();
    start();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - AWAY);
    pauseAndResume();
    expect(lastPayload<PhaseResumeData>("game-resumed")).toEqual({
      phase: "waiting-photo", duration: 5_000, phaseTotal: startDuration("waiting-photo"),
    });
  });

  it("round boundary: no photo wait started yet, phaseTotal = duration", () => {
    room = lobby();
    start();
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    // Heartbeat not detected yet: the engine only learns about it at the boundary
    rm.markDisconnected(room.gameCode, "alice", player("alice").socketId);
    rm.markDisconnected(room.gameCode, "carol", player("carol").socketId);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(room.paused).toBe(true);
    expect(room.currentPlayer).toBeNull();
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    rejoin("alice");

    const resumed = lastPayload<PhaseResumeData>("game-resumed");
    expect(resumed.phase).toBe("waiting-photo");
    expect(resumed.phaseTotal).toBe(resumed.duration);
  });
});

// A planted round has no owner picked (currentPlayer null) like a round boundary, but its photo wait did start: its
// resync payloads must be those of a normal round's wait, or phaseTotal would tell planted rounds apart
describe("a paused photo wait resyncs the same in a normal and a planted round", () => {
  /** Payloads of a first-round photo wait paused before its photo came, then resumed by alice's return. */
  function pausedPhotoWait(planted: boolean): { resumed: PhaseResumeData; snapshot: GameStateSnapshot } {
    resetEngine();
    room = lobby();
    if (planted) plantPhoto(room.gameCode, player("bob"), PLANTED);
    start(planted ? 1 : undefined);
    expect(room.currentPlayer === null).toBe(planted);
    vi.advanceTimersByTime(BEFORE_PLANTED_PHOTO);
    drop("alice");
    drop("carol");
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    const alice = rejoin("alice");
    const payloads = { resumed: lastPayload<PhaseResumeData>("game-resumed"), snapshot: snapshotFor(alice) };
    rm.clear();
    vi.clearAllTimers();
    return payloads;
  }

  it.each([["normal", false], ["planted", true]])("%s round: phaseTotal 15 s, payloads equal to a normal round's", (_kind, planted) => {
    const { resumed, snapshot } = pausedPhotoWait(planted);
    expect(resumed).toEqual({ phase: "waiting-photo", duration: PHOTO_WAIT_TIMEOUT - BEFORE_PLANTED_PHOTO, phaseTotal: PHOTO_WAIT_TIMEOUT });
    expect(snapshot).toMatchObject({ phase: "waiting-photo", duration: resumed.duration, phaseTotal: PHOTO_WAIT_TIMEOUT });

    const normal = pausedPhotoWait(false);
    expect(resumed).toEqual(normal.resumed);
    expect(snapshot).toEqual(normal.snapshot);
  });
});

describe("hold-resume phaseTotal", () => {
  it("the scores' start duration, after one or more holds", () => {
    room = lobby();
    start();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + AWAY);

    for (let hold = 0; hold < 2; hold++) {
      expect(engine.handleHold(room, owner.socketId)).toBe(true);
      vi.advanceTimersByTime(AWAY);
      expect(engine.handleRelease(room, owner.socketId)).toBe(true);
      const resumed = lastPayload<PhaseResumeData>("hold-resume");
      expect(resumed).toEqual({ phase: "scores", duration: SCORE_DISPLAY_TIME - AWAY * (hold + 1), phaseTotal: startDuration("scores") });
      vi.advanceTimersByTime(AWAY);
    }
  });
});
