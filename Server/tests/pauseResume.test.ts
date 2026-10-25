import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, MAX_PAUSES, PAUSE_MIN_DURATION, PAUSE_TIMEOUT } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-006 / DEC-009: short absences are silent (rejoin + game-state snapshot); with fewer than 2 players
// connected the game pauses with a server-driven 5 min countdown, resumes when someone returns, or ends.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg"; // shape of a POST /upload result

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const last = (name: string) => events(name)[events(name).length - 1];
const player = (name: string) => room.players.find((p) => p.username === name)!;

/** Players in a started game, first round waiting for a photo (owner picked). */
function startedRoom(names: string[]): Room {
  const r = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  engine.startGame(r);
  r.players.forEach((p) => engine.markReady(r, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  expect(r.phase).toBe("waiting-photo");
  return r;
}

/** Socket disconnect as socketRoutes handles it. */
function drop(name: string): void {
  const p = player(name);
  rm.markDisconnected(room.gameCode, name, p.socketId);
  engine.onConnectionChange(room);
}

/** Rejoin on a new socket as socketRoutes handles it. */
function rejoin(name: string): Player {
  const p = player(name);
  const res = rm.joinRoom(room.gameCode, name, `${p.socketId}-2`, p.rejoinToken);
  expect(res).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, p);
  return p;
}

function snapshotFor(socketId: string): GameStateSnapshot {
  const ev = emits.filter((e) => e.event === "game-state" && e.target === socketId).pop();
  expect(ev).toBeDefined();
  return ev!.args[0] as GameStateSnapshot;
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

describe("pause with fewer than 2 connected players", () => {
  it("freezes the answering phase, then resumes with the remaining time when the player returns", () => {
    room = startedRoom(["alice", "bob"]);
    const owner = room.currentPlayer!.username;
    const other = owner === "alice" ? "bob" : "alice";
    engine.onPhotoReceived(room, PHOTO, owner);
    vi.advanceTimersByTime(3_000);

    drop(other);
    expect(room.paused).toBe(true);
    expect(last("game-paused")).toMatchObject({ target: room.gameCode, args: [{ duration: PAUSE_TIMEOUT, waitingFor: [other], pause: 1, maxPauses: MAX_PAUSES }] });

    // Nothing advances while paused, however long it takes (within the countdown)
    vi.advanceTimersByTime(PAUSE_TIMEOUT - 1_000);
    expect(events("round-reveal")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(0);

    const p = rejoin(other);
    expect(room.paused).toBe(false);
    expect(last("game-resumed")).toMatchObject({ target: room.gameCode, args: [{ phase: "answering", duration: ANSWER_TIME - 3_000 }] });
    // Snapshot to the returning socket, after the resume: same round, photo, frozen time, no stale pause
    const snap = snapshotFor(p.socketId);
    expect(snap).toMatchObject({ started: true, phase: "answering", round: 1, owner, photo: PHOTO, correctAnswer: null, duration: ANSWER_TIME - 3_000, pause: null });
    expect(JSON.stringify(snap)).not.toContain("rejoinToken");
    const order = emits.map((e) => e.event);
    expect(order.lastIndexOf("game-state")).toBeGreaterThan(order.lastIndexOf("game-resumed"));

    vi.advanceTimersByTime(ANSWER_TIME - 3_000 - 1);
    expect(events("round-reveal")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events("round-reveal")).toHaveLength(1);
    expect(events("game-over")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1); // only the phase timer: the pause countdown is gone
  });

  it("ends the game when the countdown runs out, and stops every game timer", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    drop(other);

    vi.advanceTimersByTime(PAUSE_TIMEOUT - 1);
    expect(events("game-over")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events("game-over")).toHaveLength(1);
    expect(room.started).toBe(false);
    expect(room.paused).toBe(false);
    expect(events("round-reveal")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    // A late return gets the finished state, not a resumed game
    const p = rejoin(other);
    expect(snapshotFor(p.socketId)).toMatchObject({ started: false, phase: null, pause: null });
    expect(events("game-resumed")).toHaveLength(0);
  });

  it("keeps scores and plays no extra round across a pause during scores", () => {
    room = startedRoom(["alice", "bob"]);
    const owner = room.currentPlayer!.username;
    const other = owner === "alice" ? "bob" : "alice";
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, other, owner); // correct guess
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + 2_000); // 3 s left of scores
    expect(room.phase).toBe("scores");

    drop(other);
    vi.advanceTimersByTime(60_000);
    expect(events("your-turn")).toHaveLength(1); // only the first round's
    const p = rejoin(other);
    expect(snapshotFor(p.socketId)).toMatchObject({ phase: "scores", owner, correctAnswer: owner, duration: 3_000 });
    expect(snapshotFor(p.socketId).scores.find((s) => s.username === other)!.points).toBe(1);

    vi.advanceTimersByTime(3_000);
    expect(events("your-turn")).toHaveLength(2);
    expect(room.round).toBe(1);
    expect(player(other).points).toBe(1);
  });

  it("a pause during a hold ends the hold; resume continues the frozen scores time", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + 1_000); // 4 s left of scores
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
    vi.advanceTimersByTime(10_000);

    const others = room.players.filter((p) => p !== owner).map((p) => p.username);
    drop(others[0]);
    expect(room.paused).toBe(false); // 2 still connected: the game goes on without them
    drop(others[1]);
    expect(room.paused).toBe(true);
    expect(room.held).toBe(false);
    expect(events("hold-end")).toHaveLength(1);
    expect(engine.handleHold(room, owner.socketId)).toBe(false); // no hold while paused

    vi.advanceTimersByTime(PAUSE_TIMEOUT - 1_000); // past the hold safety timeout too
    expect(events("hold-resume")).toHaveLength(0);
    rejoin(others[1]);
    expect(last("game-resumed")!.args[0]).toEqual({ phase: "scores", duration: 4_000 });
    vi.advanceTimersByTime(4_000);
    expect(events("your-turn")).toHaveLength(2);
  });

  it("waiting-photo: a photo sent while paused is ignored and the owner is asked again on resume", () => {
    room = startedRoom(["alice", "bob"]);
    const owner = room.currentPlayer!;
    const other = owner.username === "alice" ? "bob" : "alice";
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 2_000);
    drop(other);
    engine.onPhotoReceived(room, PHOTO, owner.username);
    expect(events("round-start")).toHaveLength(0);

    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    rejoin(other);
    // The owner gets at least 5 s to (re)send the photo for the same round
    expect(last("game-resumed")!.args[0]).toEqual({ phase: "waiting-photo", duration: 5_000 });
    const turns = events("your-turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({ target: owner.socketId, event: "your-turn", args: [{ round: 1 }] });

    engine.onPhotoReceived(room, PHOTO, owner.username);
    expect(last("round-start")!.args[0]).toMatchObject({ round: 1, owner: owner.username });
    expect(events("round-skipped")).toHaveLength(0);
  });

  it("pausing at a round boundary starts that round right after the return, without skipping it", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    // Heartbeat not detected yet: the engine only learns about it at the boundary
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(room.paused).toBe(true);
    expect(room.phase).toBe("waiting-photo");
    expect(room.currentPlayer).toBeNull();

    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    const p = rejoin("bob");
    expect(snapshotFor(p.socketId)).toMatchObject({ phase: "waiting-photo", owner: null, photo: null, round: 1 });
    expect(events("your-turn")).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    expect(events("your-turn")).toHaveLength(2);
    expect(room.currentPlayer!.username).not.toBe("carol");
  });

  it("ends the game right away when the remaining players left (nobody can come back)", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    rm.removePlayer(room.gameCode, "bob");
    engine.onConnectionChange(room);
    expect(events("game-paused")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("room-of-game data stays serialisable while paused (no timers leak into it)", () => {
    room = startedRoom(["alice", "bob"]);
    drop("bob");
    const safe = rm.safeRoomData(room) as unknown as Record<string, unknown>;
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(safe).not.toHaveProperty("_pauseTimer");
    expect(safe.paused).toBe(true);
  });
});

describe("rejoin without a pause (3+ players)", () => {
  it("sends a reveal snapshot to the returning player; the game never pauses", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!.username;
    const away = room.players.find((p) => p.username !== owner)!.username;
    engine.onPhotoReceived(room, PHOTO, owner);
    drop(away);
    vi.advanceTimersByTime(ANSWER_TIME + 1_000);
    expect(room.phase).toBe("reveal");

    const p = rejoin(away);
    expect(snapshotFor(p.socketId)).toMatchObject({ phase: "reveal", round: 1, owner, photo: PHOTO, correctAnswer: owner, duration: REVEAL_TIME - 1_000, pause: null, held: false });
    expect(events("game-paused")).toHaveLength(0);
    expect(events("game-resumed")).toHaveLength(0);
    // A guess sent after the snapshot still counts during reveal
    engine.recordAnswer(room, away, owner);
    expect(player(away).points).toBe(1);
  });

  it("the photo owner returning while their photo is awaited gets your-turn again", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    drop(owner.username);
    expect(room.paused).toBe(false);
    vi.advanceTimersByTime(2_000);
    rejoin(owner.username);
    expect(snapshotFor(owner.socketId)).toMatchObject({ phase: "waiting-photo", owner: null, photo: null });
    expect(last("your-turn")).toEqual({ target: owner.socketId, event: "your-turn", args: [{ round: 1 }] });
  });
});

describe("pause abuse and edge cases (EXP-006 security review)", () => {
  it("every pause gets a full 5:00 countdown (no shared budget), up to MAX_PAUSES = 3; a 4th pause ends the game", () => {
    expect(MAX_PAUSES).toBe(3);
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    for (let n = 1; n <= MAX_PAUSES; n++) {
      drop(other);
      expect(last("game-paused")!.args[0]).toEqual({ duration: PAUSE_TIMEOUT, waitingFor: [other], pause: n, maxPauses: MAX_PAUSES });
      // Nearly the whole countdown: the next pause still gets the full 5:00
      vi.advanceTimersByTime(PAUSE_TIMEOUT - 1_000);
      expect(events("game-over")).toHaveLength(0);
      rejoin(other);
      expect(room.paused).toBe(false);
    }
    expect(events("game-paused")).toHaveLength(MAX_PAUSES);

    drop(other); // a 4th pause would be needed: game over at once
    expect(events("game-paused")).toHaveLength(MAX_PAUSES);
    expect(events("game-over")).toHaveLength(1);
    expect(room.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the last allowed pause still runs its full countdown, then game over", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    for (let n = 1; n < MAX_PAUSES; n++) {
      drop(other);
      vi.advanceTimersByTime(PAUSE_MIN_DURATION);
      rejoin(other);
    }
    drop(other);
    expect(last("game-paused")!.args[0]).toMatchObject({ duration: PAUSE_TIMEOUT, pause: MAX_PAUSES, maxPauses: MAX_PAUSES });
    vi.advanceTimersByTime(PAUSE_TIMEOUT - 1);
    expect(events("game-over")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(events("game-over")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("play again resets the pause count", () => {
    room = startedRoom(["alice", "bob"]);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    for (let n = 1; n <= MAX_PAUSES; n++) {
      drop(other);
      vi.advanceTimersByTime(PAUSE_MIN_DURATION);
      rejoin(other);
    }
    drop(other);
    expect(room.started).toBe(false);
    rejoin(other);
    emits.length = 0;
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    drop(other);
    expect(last("game-paused")!.args[0]).toMatchObject({ duration: PAUSE_TIMEOUT, pause: 1 });
  });

  it("a flapping connection (drop/rejoin every 500 ms) can't freeze the game: pauses last >= 2 s and the pause cap ends it", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    for (let t = 0; t < 20_000; t += 1_000) {
      drop(other);
      vi.advanceTimersByTime(500);
      rejoin(other);
      vi.advanceTimersByTime(500);
    }
    // Never more than one pause per 2 s, never more than MAX_PAUSES: the 4th drop ends the game
    expect(events("game-paused")).toHaveLength(MAX_PAUSES);
    expect(events("game-resumed")).toHaveLength(MAX_PAUSES);
    expect(room.started).toBe(false);
    expect(events("game-over")).toHaveLength(1);
  });

  it("a rejoin right after the pause starts resumes only once the pause reached 2 s", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    drop(other);
    vi.advanceTimersByTime(500);
    const p = rejoin(other);
    expect(room.paused).toBe(true);
    expect(events("game-resumed")).toHaveLength(0);
    expect(snapshotFor(p.socketId).pause).toEqual({ duration: PAUSE_TIMEOUT - 500, waitingFor: [], pause: 1, maxPauses: MAX_PAUSES });
    vi.advanceTimersByTime(PAUSE_MIN_DURATION - 500);
    expect(room.paused).toBe(false);
    expect(events("game-resumed")).toHaveLength(1);
  });

  it("dropping again before the scheduled resume cancels it", () => {
    room = startedRoom(["alice", "bob"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const other = room.currentPlayer!.username === "alice" ? "bob" : "alice";
    drop(other);
    vi.advanceTimersByTime(500);
    rejoin(other);
    drop(other);
    vi.advanceTimersByTime(10_000);
    expect(room.paused).toBe(true);
    expect(events("game-resumed")).toHaveLength(0);
  });

  it("while paused: someone who is awaited leaves → game-paused again with the new list; nobody left to wait for → game over", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    const [stay, a, b] = ["alice", "bob", "carol"];
    drop(a);
    drop(b);
    expect(last("game-paused")!.args[0]).toMatchObject({ waitingFor: [a, b] });
    vi.advanceTimersByTime(30_000);

    rm.removePlayer(room.gameCode, a);
    engine.onConnectionChange(room);
    expect(events("game-paused")).toHaveLength(2);
    // Same pause (not a new one): its countdown keeps running
    expect(last("game-paused")!.args[0]).toEqual({ duration: PAUSE_TIMEOUT - 30_000, waitingFor: [b], pause: 1, maxPauses: MAX_PAUSES });

    rm.removePlayer(room.gameCode, b);
    engine.onConnectionChange(room);
    expect(events("game-over")).toHaveLength(1);
    expect(player(stay).username).toBe(stay);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the snapshot hides this round's guesses (and the point they earned) until round-scores", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!.username;
    const [g1, away] = room.players.filter((p) => p.username !== owner).map((p) => p.username);
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, g1, owner); // correct
    drop(away);

    for (const phaseTime of [0, ANSWER_TIME + 500]) {
      vi.advanceTimersByTime(phaseTime);
      const p = rejoin(away);
      const snap = snapshotFor(p.socketId);
      expect(["answering", "reveal"]).toContain(snap.phase);
      for (const entry of [...snap.scores, ...snap.players]) {
        expect(entry).toMatchObject({ lastGuess: "", lastAnswerCorrect: false, points: 0 });
      }
      drop(away);
    }

    vi.advanceTimersByTime(REVEAL_TIME);
    expect(room.phase).toBe("scores");
    const p = rejoin(away);
    const scored = snapshotFor(p.socketId).scores.find((x) => x.username === g1)!;
    expect(scored).toMatchObject({ points: 1, lastGuess: owner, lastAnswerCorrect: true });
  });

  it("a pause at the round boundary keeps the points round-scores showed (no point hidden twice)", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!.username;
    const guessers = room.players.filter((p) => p.username !== owner).map((p) => p.username);
    engine.onPhotoReceived(room, PHOTO, owner);
    for (const g of guessers) engine.recordAnswer(room, g, owner); // both correct in round 1
    // Both guessers go offline unnoticed: the engine pauses at the boundary after round-scores
    for (const g of guessers) rm.markDisconnected(room.gameCode, g, player(g).socketId);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(room.paused).toBe(true);
    expect(room.phase).toBe("waiting-photo");

    const shown = last("round-scores")!.args[0] as { scores: { username: string; points: number }[] };
    const p = rejoin(guessers[0]);
    const snap = snapshotFor(p.socketId);
    const points = (list: { username: string; points: number }[]) => Object.fromEntries(list.map((x) => [x.username, x.points]));
    expect(points(snap.scores)).toEqual(points(shown.scores));
    expect(points(snap.players)).toEqual(points(shown.scores));
    expect(points(snap.scores)[guessers[0]]).toBe(1);
  });
});
