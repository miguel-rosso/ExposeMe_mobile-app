import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const HOLD_SAFETY_TIMEOUT = 30_000;

const PHOTO = "https://example.invalid/photo.jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

function events(name: string): CapturedEmit[] {
  return emits.filter((e) => e.event === name);
}

function lastEvent(name: string): CapturedEmit | undefined {
  const list = events(name);
  return list[list.length - 1];
}

/** Room with alice (host), bob, carol — mirrors join-create-game + start-game + im-ready. */
function setupStartedRoom(rounds = 10): Room {
  const r = roomManager.createRoom("alice", "sock-alice");
  roomManager.joinRoom(r.gameCode, "bob", "sock-bob");
  roomManager.joinRoom(r.gameCode, "carol", "sock-carol");
  roomManager.setRounds(r.gameCode, rounds);
  engine.startGame(r);
  r.players.forEach((p) => (p.isReady = true));
  // socketRoutes "im-ready" marks the phase before calling the engine
  r.phase = "waiting-photo";
  engine.onAllPlayersReady(r);
  return r;
}

/** From waiting-photo: owner uploads, then answering → reveal → scores → next round. */
function playFullRound(): void {
  expect(room.phase).toBe("waiting-photo");
  engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
  vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
}

function socketOf(username: string): string {
  return room.players.find((p) => p.username === username)!.socketId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  roomManager = new RoomManager();
  engine = new GameEngine(fake.io, roomManager);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Start ──────────────────────────────────────────────

describe("start", () => {
  it("startGame broadcasts game-started with players and rounds", () => {
    room = setupStartedRoom(15);
    const ev = lastEvent("game-started")!;
    expect(ev.target).toBe(room.gameCode);
    const sent = ev.args[0] as Record<string, unknown>[];
    expect(sent.map((p) => p.username)).toEqual(["alice", "bob", "carol"]);
    for (const p of sent) {
      expect(p).not.toHaveProperty("rejoinToken");
      expect(p).not.toHaveProperty("plantedPhoto");
    }
    expect(ev.args[1]).toBe(15);
    expect(room.started).toBe(true);
    expect(room.round).toBe(0);
  });

  it("sends your-turn (round 1) only to the chosen player after the start delay", () => {
    room = setupStartedRoom();
    vi.advanceTimersByTime(GAME_START_DELAY - 1);
    expect(events("your-turn")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const ev = lastEvent("your-turn")!;
    expect(ev.target).toBe(room.currentPlayer!.socketId);
    expect(ev.args[0]).toEqual({ round: 1 });
    expect(room.phase).toBe("waiting-photo");
    expect(room.round).toBe(0);
  });
});

// ── Phases ─────────────────────────────────────────────

describe("round phases", () => {
  beforeEach(() => {
    room = setupStartedRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
  });

  it("photo → answering (8s) → reveal (3s) → scores (5s) → next your-turn", () => {
    const owner = room.currentPlayer!.username;
    engine.onPhotoReceived(room, PHOTO, owner);

    expect(room.phase).toBe("answering");
    expect(room.round).toBe(1);
    const start = lastEvent("round-start")!;
    expect(start.target).toBe(room.gameCode);
    expect(start.args[0]).toEqual({ photo: PHOTO, owner, round: 1, duration: ANSWER_TIME });

    vi.advanceTimersByTime(ANSWER_TIME - 1);
    expect(events("round-reveal")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("reveal");
    expect(lastEvent("round-reveal")!.args[0]).toEqual({ correctAnswer: owner, duration: REVEAL_TIME });

    vi.advanceTimersByTime(REVEAL_TIME - 1);
    expect(events("round-scores")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("scores");
    const scores = lastEvent("round-scores")!.args[0] as Record<string, unknown>;
    expect(scores).toMatchObject({ round: 1, totalRounds: 10, duration: SCORE_DISPLAY_TIME });
    expect(scores.scores).toHaveLength(3);

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 1);
    expect(events("your-turn")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events("your-turn")).toHaveLength(2);
    expect(lastEvent("your-turn")!.args[0]).toEqual({ round: 2 });
    expect(room.phase).toBe("waiting-photo");
  });

  it("ignores a photo from anyone but the current owner", () => {
    const owner = room.currentPlayer!.username;
    const other = room.players.find((p) => p.username !== owner)!.username;
    engine.onPhotoReceived(room, PHOTO, other);
    expect(events("round-start")).toHaveLength(0);
    expect(room.phase).toBe("waiting-photo");
    engine.onPhotoReceived(room, PHOTO, owner);
    expect(lastEvent("round-start")!.args[0]).toMatchObject({ owner });
  });

  it("ignores photo-sent outside waiting-photo", () => {
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    engine.onPhotoReceived(room, "https://example.invalid/other.jpg", room.currentPlayer!.username);
    expect(events("round-start")).toHaveLength(1);
    expect(room.round).toBe(1);
  });

  it("skips the round after 15s without a photo, keeping the round number", () => {
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1);
    expect(events("round-skipped")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    const skipped = lastEvent("round-skipped")!;
    expect(skipped.target).toBe(room.gameCode);
    expect(room.round).toBe(0);
    expect(room.phase).toBe("waiting-photo");
    expect(events("your-turn")).toHaveLength(2);
    expect(lastEvent("your-turn")!.args[0]).toEqual({ round: 1 });
  });

  it("does not skip once the photo arrived before the timeout", () => {
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1_000);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(events("round-skipped")).toHaveLength(0);
  });
});

// ── Game over ──────────────────────────────────────────

describe("game over", () => {
  it("emits game-over after N rounds with scores sorted desc and stops all timers", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);

    for (let i = 0; i < 10; i++) {
      const owner = room.currentPlayer!.username;
      engine.onPhotoReceived(room, PHOTO, owner);
      // bob always guesses alice, carol always guesses the real owner
      engine.recordAnswer(room, "bob", "alice");
      engine.recordAnswer(room, "carol", owner);
      vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    }

    expect(events("round-start")).toHaveLength(10);
    expect(events("round-scores")).toHaveLength(10);
    expect(events("game-over")).toHaveLength(1);
    const over = lastEvent("game-over")!;
    expect(over.target).toBe(room.gameCode);
    const finalScore = (over.args[0] as { finalScore: { username: string; points: number }[] }).finalScore;
    expect(finalScore).toHaveLength(3);
    const points = finalScore.map((s) => s.points);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    // carol guessed every round she could answer (the owner may also answer; recordAnswer doesn't block it)
    expect(finalScore.find((s) => s.username === "carol")!.points).toBe(10);

    expect(room.started).toBe(false);
    expect(room.phase).toBeNull();
    expect(room.players.every((p) => !p.isReady)).toBe(true);
    expect(room.round).toBe(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the game at the next round boundary when fewer than 2 players remain", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    roomManager.removePlayer(room.gameCode, "bob");
    roomManager.removePlayer(room.gameCode, "carol");
    // alice may have been the owner or not — either way the round finishes, then game-over
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(events("game-over")).toHaveLength(1);
    expect(room.phase).toBeNull();
  });

  it("plays exactly one planted round per planted photo, without your-turn for it", () => {
    room = roomManager.createRoom("alice", "sock-alice");
    roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
    roomManager.joinRoom(room.gameCode, "carol", "sock-carol");
    const planted = "https://example.invalid/planted.jpg";
    room.players[1].plantedPhoto = planted;
    engine.startGame(room);
    room.players.forEach((p) => (p.isReady = true));
    room.phase = "waiting-photo";
    engine.onAllPlayersReady(room);
    vi.advanceTimersByTime(GAME_START_DELAY);

    for (let i = 0; i < 10; i++) {
      if (room.phase === "waiting-photo") engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    }

    const starts = events("round-start").map((e) => e.args[0] as { photo: string; owner: string; round: number });
    expect(starts).toHaveLength(10);
    expect(starts.map((s) => s.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const plantedStarts = starts.filter((s) => s.photo === planted);
    expect(plantedStarts).toHaveLength(1);
    expect(plantedStarts[0].owner).toBe("bob");
    expect(events("your-turn")).toHaveLength(9);
    expect(room.plantedPhotosShown).toBe(1);
    expect(events("game-over")).toHaveLength(1);
  });
});

// ── Answers ────────────────────────────────────────────

describe("recordAnswer", () => {
  let owner: string;
  let guessers: string[];

  beforeEach(() => {
    room = setupStartedRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
    owner = room.currentPlayer!.username;
    guessers = room.players.map((p) => p.username).filter((u) => u !== owner);
  });

  const player = (u: string) => room.players.find((p) => p.username === u)!;

  it("ignores answers while waiting for the photo", () => {
    engine.recordAnswer(room, guessers[0], owner);
    expect(player(guessers[0]).points).toBe(0);
    expect(player(guessers[0]).lastGuess).toBe("");
  });

  it("awards a point for the correct guess and none for a wrong one", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    engine.recordAnswer(room, guessers[1], guessers[0]);

    expect(player(guessers[0])).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
    expect(player(guessers[1])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[0] });
  });

  it("only accepts the first answer per round", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], guessers[1]);
    engine.recordAnswer(room, guessers[0], owner);
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[1] });
  });

  it("accepts answers during reveal but not during scores", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    engine.recordAnswer(room, guessers[0], owner);
    expect(player(guessers[0]).points).toBe(1);

    vi.advanceTimersByTime(REVEAL_TIME);
    expect(room.phase).toBe("scores");
    engine.recordAnswer(room, guessers[1], owner);
    expect(player(guessers[1]).points).toBe(0);
  });

  it("stores an empty guess as '(no guess)'", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], "");
    expect(player(guessers[0])).toMatchObject({ points: 0, lastGuess: "(no guess)" });
  });

  it("ignores unknown players", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    expect(() => engine.recordAnswer(room, "nobody", owner)).not.toThrow();
  });

  it("includes the answer in round-scores and resets it for the next round", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const { scores } = lastEvent("round-scores")!.args[0] as { scores: { username: string; lastGuess: string; lastAnswerCorrect: boolean; points: number }[] };
    expect(scores[0]).toMatchObject({ username: guessers[0], points: 1, lastAnswerCorrect: true, lastGuess: owner });

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    room.players.forEach((p) => {
      expect(p.lastGuess).toBe("");
      expect(p.lastAnswerCorrect).toBe(false);
    });
    expect(player(guessers[0]).points).toBe(1);
  });

  // Possible bug (follow-up): the photo owner can answer their own photo and score a point.
  it.todo("rejects answers from the photo owner");
});

// ── Hold ───────────────────────────────────────────────

describe("hold", () => {
  let ownerSocket: string;

  /** Advance into the scores phase of round 1. */
  function toScores(): void {
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
  }

  beforeEach(() => {
    room = setupStartedRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
    ownerSocket = room.currentPlayer!.socketId;
  });

  it("pauses the scores timer and resumes with the remaining time", () => {
    toScores();
    vi.advanceTimersByTime(2_000);
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    expect(room.held).toBe(true);

    // Held: the scores timer must not fire (stay below the 30s safety)
    vi.advanceTimersByTime(20_000);
    expect(events("your-turn")).toHaveLength(1);
    expect(room.phase).toBe("scores");

    expect(engine.handleRelease(room, ownerSocket)).toBe(true);
    expect(room.held).toBe(false);
    const resume = lastEvent("hold-resume")!;
    expect(resume.target).toBe(room.gameCode);
    expect(resume.args[0]).toEqual({ phase: "scores", duration: SCORE_DISPLAY_TIME - 2_000 });

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 2_000 - 1);
    expect(events("your-turn")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events("your-turn")).toHaveLength(2);
    expect(room.phase).toBe("waiting-photo");
  });

  it("rejects hold from anyone but the photo owner", () => {
    toScores();
    const other = room.players.find((p) => p.socketId !== ownerSocket)!.socketId;
    expect(engine.handleHold(room, other)).toBe(false);
    expect(room.held).toBe(false);
  });

  it("rejects hold outside the scores phase (answering, reveal)", () => {
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
  });

  // GAME_FLOW.md says hold is available during reveal AND scores; the engine only allows scores.
  it.todo("allows hold during reveal as documented in GAME_FLOW.md (doc/code mismatch, follow-up)");

  it("rejects hold when less than 1.5s of scores remain", () => {
    toScores();
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 1_000);
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
  });

  it("rejects a second hold while held and a release from a non-owner", () => {
    toScores();
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    const other = room.players.find((p) => p.socketId !== ownerSocket)!.socketId;
    expect(engine.handleRelease(room, other)).toBe(false);
    expect(room.held).toBe(true);
  });

  it("rejects release when not held", () => {
    toScores();
    expect(engine.handleRelease(room, ownerSocket)).toBe(false);
    expect(events("hold-resume")).toHaveLength(0);
  });

  it("force-releases after the 30s safety timeout and then continues", () => {
    toScores();
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    vi.advanceTimersByTime(HOLD_SAFETY_TIMEOUT - 1);
    expect(room.held).toBe(true);
    vi.advanceTimersByTime(1);

    expect(room.held).toBe(false);
    expect(lastEvent("hold-resume")!.args[0]).toEqual({ phase: "scores", duration: SCORE_DISPLAY_TIME });
    expect(events("hold-end")).toHaveLength(1);

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(events("your-turn")).toHaveLength(2);
  });

  it("resumes with at least 1.5s even if the hold started near the minimum", () => {
    toScores();
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 1_500);
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    engine.handleRelease(room, ownerSocket);
    expect(lastEvent("hold-resume")!.args[0]).toEqual({ phase: "scores", duration: 1_500 });
  });
});

// ── Offline players / skip cap (EXP-018) ───────────────

describe("offline players and skip cap", () => {
  const MAX_CONSECUTIVE_SKIPS = 3;

  it("never picks a disconnected player for your-turn", () => {
    // Always pick the last candidate: without the connected filter that is carol (offline) every round.
    // Restored by vi.restoreAllMocks() in afterEach.
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    room = setupStartedRoom(10);
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(GAME_START_DELAY);

    for (let i = 0; i < 10; i++) playFullRound();

    const targets = events("your-turn").map((e) => e.target);
    expect(targets).toHaveLength(10);
    expect(targets).not.toContain("sock-carol");
    expect(events("round-skipped")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(1);
  });

  it("ends the game instead of looping when fewer than 2 players are connected", () => {
    room = setupStartedRoom(10);
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(GAME_START_DELAY);

    expect(events("your-turn")).toHaveLength(0);
    expect(events("round-skipped")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(1);
    expect(room.phase).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the game at the next round boundary when players go offline mid-game", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(events("game-over")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`ends the game after ${MAX_CONSECUTIVE_SKIPS} consecutive skipped rounds and stops all timers`, () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));
    expect(events("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS - 1);
    expect(events("game-over")).toHaveLength(0);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(events("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS);
    expect(events("game-over")).toHaveLength(1);
    expect(room.phase).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * 10);
    expect(events("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS);
  });

  it("a played round resets the consecutive skip counter", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));
    playFullRound();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));

    expect(events("round-skipped")).toHaveLength((MAX_CONSECUTIVE_SKIPS - 1) * 2);
    expect(events("game-over")).toHaveLength(0);
    expect(room.phase).toBe("waiting-photo");
  });
});
