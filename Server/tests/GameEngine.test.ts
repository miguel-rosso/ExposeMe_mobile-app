import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, ANSWER_TIME, GameEngine } from "../managers/GameEngine";
import { PLANTED_DELAY_MAX } from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const HOLD_SAFETY_TIMEOUT = 30_000;
const READY_TIMEOUT = 10_000;
const PAUSE_TIMEOUT = 5 * 60_000;

const PHOTO = "https://example.invalid/photo.jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

function events(name: string): CapturedEmit[] {
  return emits.filter((e) => e.event === name);
}

/** Room-wide emits only (leaves out events sent to one socket, e.g. your-turn) */
function roomEvents(name: string): CapturedEmit[] {
  return events(name).filter((e) => e.target === room.gameCode);
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
    expect(ev.args[0]).toEqual({ round: 1, attempt: 1 });
    expect(room.phase).toBe("waiting-photo");
    expect(room.round).toBe(0);
  });
});

// ── Ready timeout (EXP-010) ────────────────────────────

describe("im-ready and ready timeout", () => {
  /** alice, bob, carol in a started game, nobody ready yet. */
  function startedNotReady(): Room {
    const r = roomManager.createRoom("alice", "sock-alice");
    roomManager.joinRoom(r.gameCode, "bob", "sock-bob");
    roomManager.joinRoom(r.gameCode, "carol", "sock-carol");
    engine.startGame(r);
    return r;
  }
  const player = (name: string) => room.players.find((p) => p.username === name)!;

  it("starts as soon as every player is ready, and only once", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    expect(room.phase).toBeNull();
    engine.markReady(room, player("carol"));
    expect(room.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    // neither a duplicate im-ready nor the ready timeout start the game again
    engine.markReady(room, player("alice"));
    vi.advanceTimersByTime(READY_TIMEOUT);
    expect(events("your-turn")).toHaveLength(1);
  });

  it("starts with whoever is ready when someone never sends im-ready", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    vi.advanceTimersByTime(READY_TIMEOUT - 1);
    expect(room.phase).toBeNull();
    expect(events("your-turn")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    expect(lastEvent("your-turn")!.args[0]).toEqual({ round: 1, attempt: 1 });

    // a late im-ready does not restart anything
    engine.markReady(room, player("carol"));
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
  });

  it("starts after the timeout even if nobody sent im-ready", () => {
    room = startedNotReady();
    vi.advanceTimersByTime(READY_TIMEOUT + GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    expect(events("game-over")).toHaveLength(0);
  });

  it("does not wait for (or pick) a player who disconnected before im-ready", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99); // would pick the last player, carol, among all three
    room = startedNotReady();
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    // every connected player is ready: no need to wait for the timeout
    expect(room.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(GAME_START_DELAY);
    const turn = lastEvent("your-turn")!;
    expect(turn.target).not.toBe("sock-carol");
    expect(room.currentPlayer!.username).not.toBe("carol");
  });

  it("never picks a player who disconnected before the ready timeout", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("carol"));
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol"); // ready, then went away
    vi.advanceTimersByTime(READY_TIMEOUT + GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    expect(room.currentPlayer!.username).not.toBe("carol");
  });

  it("pauses at the timeout when fewer than 2 players are connected, and ends the game when nobody returns", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(READY_TIMEOUT + GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(0);
    expect(events("game-paused")).toHaveLength(1);
    expect(events("game-over")).toHaveLength(0);
    vi.advanceTimersByTime(PAUSE_TIMEOUT);
    expect(events("game-over")).toHaveLength(1);
    expect(room.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a lone connected player's im-ready does not start the game; the timeout or a rejoin does", () => {
    room = startedNotReady();
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.markReady(room, player("alice"));
    expect(room.phase).toBeNull();
    vi.advanceTimersByTime(READY_TIMEOUT - 1);
    expect(events("game-over")).toHaveLength(0);
    expect(events("your-turn")).toHaveLength(0);

    // bob comes back inside the window and gets ready: 2 connected, all ready → start
    expect(roomManager.joinRoom(room.gameCode, "bob", "sock-bob2", player("bob").rejoinToken).success).toBe(true);
    engine.markReady(room, player("bob"));
    expect(room.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    expect(room.currentPlayer!.username).not.toBe("carol");
    expect(events("game-over")).toHaveLength(0);
  });

  it("checkReady starts right away when the only not-ready player disconnects", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.checkReady(room);
    expect(room.phase).toBe("waiting-photo");
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(1);
    expect(room.currentPlayer!.username).not.toBe("carol");
  });

  it("checkReady starts right away when the only not-ready player leaves", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    roomManager.removePlayer(room.gameCode, "carol");
    engine.checkReady(room);
    expect(room.phase).toBe("waiting-photo");
  });

  it("checkReady does nothing with fewer than 2 connected players or someone not ready", () => {
    room = startedNotReady();
    engine.markReady(room, player("alice"));
    engine.checkReady(room); // bob and carol connected, not ready
    expect(room.phase).toBeNull();
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.checkReady(room); // alice alone
    expect(room.phase).toBeNull();
    expect(events("game-over")).toHaveLength(0);
  });

  describe("everyone but one leaves (DEC-011: end at once if nobody can come back)", () => {
    it("ends the game right away, with no round played, when the only other player leaves", () => {
      room = roomManager.createRoom("alice", "sock-alice");
      roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
      engine.startGame(room);
      engine.markReady(room, player("alice"));
      engine.removePlayer(room, "bob", "left");

      expect(roomEvents("game-over")).toHaveLength(1);
      expect(lastEvent("game-over")!.args[0]).toEqual({ finalScore: [expect.objectContaining({ username: "alice", points: 0 })] });
      expect(room.started).toBe(false);
      expect(room.phase).toBeNull();
      expect(player("alice").isReady).toBe(false);
      expect(vi.getTimerCount()).toBe(0); // the ready timeout is gone: no late round 1
      vi.advanceTimersByTime(READY_TIMEOUT + GAME_START_DELAY);
      expect(events("waiting-photo")).toHaveLength(0);
      expect(events("game-paused")).toHaveLength(0);
      expect(events("game-over")).toHaveLength(1);
    });

    it("ends the game when the last connected player but one leaves and nobody is disconnected", () => {
      room = startedNotReady();
      engine.removePlayer(room, "carol", "left");
      expect(events("game-over")).toHaveLength(0); // alice and bob can still play
      engine.removePlayer(room, "bob", "left");
      expect(events("game-over")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not end the game while someone who left one alone is only disconnected (they may come back)", () => {
      room = startedNotReady();
      roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
      engine.checkReady(room);
      engine.onConnectionChange(room);
      engine.removePlayer(room, "bob", "left");
      expect(events("game-over")).toHaveLength(0);
      expect(room.started).toBe(true);
      expect(room.phase).toBeNull();
      // Same as before: the ready timeout starts and, with fewer than 2 connected, the game pauses for carol
      vi.advanceTimersByTime(READY_TIMEOUT + GAME_START_DELAY);
      expect(events("game-paused")).toHaveLength(1);
      expect(events("game-over")).toHaveLength(0);
    });

    it("does not end the game when the others only disconnect", () => {
      room = startedNotReady();
      engine.markReady(room, player("alice"));
      for (const name of ["bob", "carol"]) {
        roomManager.markDisconnected(room.gameCode, name, `sock-${name}`);
        engine.checkReady(room);
        engine.onConnectionChange(room);
      }
      expect(events("game-over")).toHaveLength(0);
      expect(room.started).toBe(true);
      expect(room.phase).toBeNull();
    });

    it("ends the game when a rejoin leaves a single player in the room (the other one left meanwhile)", () => {
      room = roomManager.createRoom("alice", "sock-alice");
      roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
      engine.startGame(room);
      roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
      engine.onConnectionChange(room);
      engine.removePlayer(room, "alice", "left");
      expect(events("game-over")).toHaveLength(0); // bob may still come back

      const bob = player("bob");
      expect(roomManager.joinRoom(room.gameCode, "bob", "sock-bob2", bob.rejoinToken)).toMatchObject({ success: true, rejoin: true });
      engine.onPlayerRejoined(room, bob);
      expect(events("game-over")).toHaveLength(1);
      expect(room.started).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // The rejoiner's snapshot says the game is over
      expect(lastEvent("game-state")).toMatchObject({ target: "sock-bob2", args: [expect.objectContaining({ started: false })] });
    });
  });

  it("answers an im-ready sent after the game ended with a not-started game-state to that player only", () => {
    room = roomManager.createRoom("alice", "sock-alice");
    roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
    engine.startGame(room);
    engine.removePlayer(room, "bob", "left"); // game-over goes out before alice's game screen listens for it
    expect(events("game-over")).toHaveLength(1);

    engine.markReady(room, player("alice"));
    expect(events("game-state")).toHaveLength(1);
    const reply = lastEvent("game-state")!;
    expect(reply.target).toBe("sock-alice");
    expect(reply.args[0]).toMatchObject({ started: false, phase: null, scores: [expect.objectContaining({ username: "alice", points: 0 })] });
    expect(player("alice").isReady).toBe(false);
    expect(room.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores im-ready outside the ready window", () => {
    room = roomManager.createRoom("alice", "sock-alice");
    roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
    engine.markReady(room, player("alice")); // lobby: game not started
    expect(player("alice").isReady).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Phases ─────────────────────────────────────────────

describe("round phases", () => {
  beforeEach(() => {
    room = setupStartedRoom();
    vi.advanceTimersByTime(GAME_START_DELAY);
  });

  it("photo → answering (8.5s) → reveal (3s) → scores (5s) → next your-turn", () => {
    const owner = room.currentPlayer!.username;
    engine.onPhotoReceived(room, PHOTO, owner);

    expect(room.phase).toBe("answering");
    expect(room.round).toBe(1);
    // One copy for the whole room, owner included: nobody is told whose photo it is (EXP-252)
    const starts = events("round-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      target: room.gameCode, event: "round-start", args: [{ photo: PHOTO, round: 1, duration: ANSWER_TIME - ANSWER_GRACE }],
    });

    vi.advanceTimersByTime(ANSWER_TIME - 1);
    expect(events("round-reveal")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("reveal");
    // One per player: the answer, and their own recorded guess (nobody answered)
    expect(events("round-reveal")).toEqual(room.players.map((p) => ({
      target: p.socketId, event: "round-reveal", args: [{ correctAnswer: owner, duration: REVEAL_TIME, yourGuess: "" }],
    })));

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
    expect(lastEvent("your-turn")!.args[0]).toEqual({ round: 2, attempt: 2 });
    expect(room.phase).toBe("waiting-photo");
  });

  it("ignores a photo from anyone but the current owner", () => {
    const owner = room.currentPlayer!.username;
    const other = room.players.find((p) => p.username !== owner)!.username;
    engine.onPhotoReceived(room, PHOTO, other);
    expect(events("round-start")).toHaveLength(0);
    expect(room.phase).toBe("waiting-photo");
    engine.onPhotoReceived(room, PHOTO, owner);
    expect(lastEvent("round-start")).toMatchObject({ target: room.gameCode, args: [{ photo: PHOTO }] });
  });

  it("ignores photo-sent outside waiting-photo", () => {
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    engine.onPhotoReceived(room, "https://example.invalid/other.jpg", room.currentPlayer!.username);
    expect(roomEvents("round-start")).toHaveLength(1);
    expect(room.round).toBe(1);
  });

  it("skips the round after 15s without a photo, keeping the round number", () => {
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1);
    expect(events("round-skipped")).toHaveLength(0);

    const owner = room.currentPlayer!;
    vi.advanceTimersByTime(1);
    // The room learns no reason (EXP-110); the owner gets theirs in their own copy
    expect(events("round-skipped")).toEqual([
      { target: room.gameCode, except: owner.socketId, event: "round-skipped", args: [{ round: 1 }] },
      { target: owner.socketId, event: "round-skipped", args: [{ round: 1, reason: "timeout" }] },
    ]);
    expect(room.round).toBe(0);
    expect(room.phase).toBe("waiting-photo");
    expect(events("your-turn")).toHaveLength(2);
    expect(lastEvent("your-turn")!.args[0]).toEqual({ round: 1, attempt: 2 });
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

    expect(roomEvents("round-start")).toHaveLength(10);
    expect(events("round-scores")).toHaveLength(10);
    expect(events("game-over")).toHaveLength(1);
    const over = lastEvent("game-over")!;
    expect(over.target).toBe(room.gameCode);
    const finalScore = (over.args[0] as { finalScore: { username: string; points: number }[] }).finalScore;
    expect(finalScore).toHaveLength(3);
    const points = finalScore.map((s) => s.points);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    // carol guessed every round, her own photos included (the owner plays like everyone, EXP-252)
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
    const planted = "/temp/" + "c".repeat(32) + ".jpg";
    plantPhoto(room.gameCode, room.players[1], planted);
    engine.startGame(room);
    room.players.forEach((p) => (p.isReady = true));
    room.phase = "waiting-photo";
    engine.onAllPlayersReady(room);
    vi.advanceTimersByTime(GAME_START_DELAY);

    for (let i = 0; i < 10; i++) {
      // Planted round: a photo wait with no owner picked, then round-start within the planted delay
      if (room.phase === "waiting-photo" && !room.currentPlayer) vi.advanceTimersByTime(PLANTED_DELAY_MAX);
      if (room.phase === "waiting-photo") engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    }

    const starts = roomEvents("round-start").map((e) => e.args[0] as { photo: string; round: number });
    expect(starts).toHaveLength(10);
    expect(starts.map((s) => s.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Every round-start goes to the whole room, the planter included: nobody is told who planted it
    expect(events("round-start")).toHaveLength(10);
    const plantedStarts = roomEvents("round-start").filter((e) => (e.args[0] as { photo: string }).photo === planted);
    expect(plantedStarts).toHaveLength(1);
    expect(plantedStarts[0]).not.toHaveProperty("except");
    expect(events("your-turn")).toHaveLength(9);
    // Every round, planted included, was announced with waiting-photo first
    expect(roomEvents("waiting-photo")).toHaveLength(10);
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

  // EXP-252: the owner may not recognise their photo, so they guess like everyone else (and are scored the same)
  it("records and scores the photo owner's vote like any other, until answering ends", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, owner, owner);
    expect(player(owner)).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
    engine.recordAnswer(room, owner, guessers[0]);
    expect(player(owner)).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[0] });
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    engine.recordAnswer(room, owner, owner); // frozen like everyone's
    expect(player(owner)).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[0] });
  });

  // EXP-148: the app sends its pick when tapped and may change it until answering ends; the last one counts
  it("keeps the last selection made during answering (re-selecting moves the point)", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], guessers[1]);
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[1] });
    engine.recordAnswer(room, guessers[0], owner);
    expect(player(guessers[0])).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
    engine.recordAnswer(room, guessers[0], owner); // same pick again: still one point
    expect(player(guessers[0]).points).toBe(1);
    engine.recordAnswer(room, guessers[0], guessers[1]); // switched away from the right answer: point taken back
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[1] });
    engine.recordAnswer(room, guessers[0], owner);
    engine.recordAnswer(room, guessers[0], ""); // deselected
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: "" });
    engine.recordAnswer(room, guessers[0], owner); // last selection before answering ends
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const { scores } = lastEvent("round-scores")!.args[0] as { scores: { username: string; lastGuess: string; points: number }[] };
    expect(scores.find((x) => x.username === guessers[0])).toMatchObject({ points: 1, lastGuess: owner });
  });

  // EXP-148: round-reveal broadcasts correctAnswer, so answers are frozen when answering ends
  it("ignores answers during reveal and scores, without changing a pick made during answering", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[1], guessers[0]); // wrong pick while answering
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    engine.recordAnswer(room, guessers[0], owner); // hadn't voted, now knows the answer
    engine.recordAnswer(room, guessers[1], owner); // tries to fix the wrong pick
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: "" });
    expect(player(guessers[1])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[0] });

    vi.advanceTimersByTime(REVEAL_TIME);
    expect(room.phase).toBe("scores");
    engine.recordAnswer(room, guessers[0], owner);
    expect(player(guessers[0])).toMatchObject({ points: 0, lastGuess: "" });
  });

  // EXP-148: clients are shown ANSWER_TIME - ANSWER_GRACE, but answers are taken until ANSWER_TIME, so a tap made
  // at the very end of the bar still arrives in time
  it("shows the answer time minus a grace and still takes answers until the real end of answering", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    expect(ANSWER_GRACE).toBeGreaterThan(0);
    expect((events("round-start")[0].args[0] as { duration: number }).duration).toBe(ANSWER_TIME - ANSWER_GRACE);
    vi.advanceTimersByTime(ANSWER_TIME - 1);
    expect(room.phase).toBe("answering");
    expect(engine.snapshot(room).duration).toBe(0); // the bar has run out on every client
    engine.recordAnswer(room, guessers[0], owner); // sent as the bar ended: counts
    vi.advanceTimersByTime(1);
    expect(room.phase).toBe("reveal");
    expect(player(guessers[0])).toMatchObject({ points: 1, lastGuess: owner });
  });

  // EXP-306 / DEC-042: Android phones got round-start up to ~770 ms late, so their bar (and last tap) ended that much
  // after the server's; the bar players see stays 7.7 s while the server takes answers for 800 ms more
  describe("late round-start delivery (EXP-306)", () => {
    const SHOWN_BAR = 7_700;
    const COVERED_DELAY = 700;
    const UNCOVERED_DELAY = 900;
    const startRoundAndReachBarEnd = (deliveryDelay: number): void => {
      engine.onPhotoReceived(room, PHOTO, owner);
      expect((events("round-start")[0].args[0] as { duration: number }).duration).toBe(SHOWN_BAR);
      vi.advanceTimersByTime(SHOWN_BAR + deliveryDelay); // the phone's bar ends deliveryDelay after the server's
    };

    it("counts a pick sent as the bar ended on a phone that got round-start 700 ms late", () => {
      startRoundAndReachBarEnd(COVERED_DELAY);
      expect(room.phase).toBe("answering");
      engine.recordAnswer(room, guessers[0], owner);
      vi.advanceTimersByTime(ANSWER_TIME - SHOWN_BAR - COVERED_DELAY);
      expect(room.phase).toBe("reveal");
      expect(player(guessers[0])).toMatchObject({ points: 1, lastGuess: owner });
    });

    it("drops a pick sent as the bar ended on a phone that got round-start 900 ms late", () => {
      startRoundAndReachBarEnd(UNCOVERED_DELAY);
      expect(room.phase).toBe("reveal");
      engine.recordAnswer(room, guessers[0], owner);
      expect(player(guessers[0])).toMatchObject({ points: 0, lastGuess: "" });
    });
  });

  // EXP-148: only the round's options can be voted for
  it("ignores a guess for a name that is not an option of the round, keeping the previous pick", () => {
    roomManager.removePlayer(room.gameCode, guessers[1]); // left before the round: not one of its options
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    engine.recordAnswer(room, guessers[0], "nobody");
    engine.recordAnswer(room, guessers[0], guessers[1]);
    expect(player(guessers[0])).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
  });

  // EXP-301 / DEC-038: the owner who leaves while answering stays the round's answer, and a right guess still scores
  it("keeps scoring the owner who left during the round, also for guesses sent after they left", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    roomManager.removePlayer(room.gameCode, owner);
    engine.recordAnswer(room, guessers[1], owner); // tapped after the owner left (or re-sent on a rejoin)
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(lastEvent("round-reveal")!.args[0]).toMatchObject({ correctAnswer: owner });
    expect(player(guessers[0])).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
    expect(player(guessers[1])).toMatchObject({ points: 1, lastAnswerCorrect: true, lastGuess: owner });
  });

  // EXP-301: a client that missed the player-left (offline, app restarted) rebuilds the round's options from game-state
  it("sends the round's options in the snapshot, leavers included, answers hidden, only during the round", () => {
    const names = room.players.map((p) => p.username);
    expect(engine.snapshot(room).roundOptions).toEqual([]); // waiting for the photo
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    roomManager.removePlayer(room.gameCode, owner);
    const options = engine.snapshot(room).roundOptions;
    expect(options.map((p) => p.username)).toEqual(names);
    // Public fields only, this round's answers hidden like in `players`
    for (const option of options) expect(Object.keys(option).sort()).toEqual(["connected", "isHost", "lastAnswerCorrect", "lastGuess", "points", "username"]);
    expect(options.find((p) => p.username === guessers[0])).toMatchObject({ points: 0, lastGuess: "", lastAnswerCorrect: false });
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
    expect(engine.snapshot(room).roundOptions.map((p) => p.username)).toEqual(names);
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(room.phase).toBe("waiting-photo");
    expect(engine.snapshot(room).roundOptions).toEqual([]);
  });

  // A host who leaves hands the role over: the round options show only the new host as such
  it("shows only the host in the room as host among the round's options", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    const host = room.players.find((p) => p.isHost)!.username;
    const { newHost } = roomManager.removePlayer(room.gameCode, host);
    const hosts = engine.snapshot(room).roundOptions.filter((p) => p.isHost).map((p) => p.username);
    expect(hosts).toEqual([newHost!.username]);
    expect(engine.snapshot(room).roundOptions.find((p) => p.username === host)).toMatchObject({ isHost: false });
  });

  // DEC-038: another player who leaves during the round is still not the answer: a pick on them scores nothing
  it("records a guess for a non-owner who left during the round as a wrong one", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], owner);
    roomManager.removePlayer(room.gameCode, guessers[1]);
    engine.recordAnswer(room, guessers[0], guessers[1]); // moved to the leaver: the right pick is replaced
    expect(player(guessers[0])).toMatchObject({ points: 0, lastAnswerCorrect: false, lastGuess: guessers[1] });
  });

  it("stores an empty guess as \"\" (the client translates it, EXP-132)", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guessers[0], "");
    expect(player(guessers[0])).toMatchObject({ points: 0, lastGuess: "" });
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

  // EXP-252: the owner's pick reaches round-scores like anyone's
  it("shows the photo owner's own-name guess as correct in round-scores", () => {
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, owner, owner);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const { scores } = lastEvent("round-scores")!.args[0] as { scores: { username: string; lastGuess: string; lastAnswerCorrect: boolean; points: number }[] };
    expect(scores.find((s) => s.username === owner)).toMatchObject({ points: 1, lastGuess: owner, lastAnswerCorrect: true });
  });
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
    expect(resume.args[0]).toEqual({ phase: "scores", duration: SCORE_DISPLAY_TIME - 2_000, phaseTotal: SCORE_DISPLAY_TIME });

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

  // EXP-014: hold is scores-only (GAME_FLOW.md "Hold"): every earlier phase of the round refuses it
  it("allows hold only in the scores phase", () => {
    expect(room.phase).toBe("waiting-photo");
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    expect(room.phase).toBe("answering");
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(room.phase).toBe("scores");
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    expect(room.held).toBe(true);
  });

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
    expect(lastEvent("hold-resume")!.args[0]).toEqual({ phase: "scores", duration: SCORE_DISPLAY_TIME, phaseTotal: SCORE_DISPLAY_TIME });
    expect(events("hold-end")).toHaveLength(1);

    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(events("your-turn")).toHaveLength(2);
  });

  it("resumes with at least 1.5s even if the hold started near the minimum", () => {
    toScores();
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME - 1_500);
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    engine.handleRelease(room, ownerSocket);
    expect(lastEvent("hold-resume")!.args[0]).toEqual({ phase: "scores", duration: 1_500, phaseTotal: SCORE_DISPLAY_TIME });
  });

  // Hold limits per round (EXP-167)
  it("allows at most 3 holds per round", () => {
    toScores();
    for (let i = 0; i < 3; i++) {
      expect(engine.handleHold(room, ownerSocket)).toBe(true);
      vi.advanceTimersByTime(100);
      expect(engine.handleRelease(room, ownerSocket)).toBe(true);
    }
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    expect(room.held).toBe(false);
  });

  it("caps the total hold time of a round at 30s, across holds", () => {
    toScores();
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(engine.handleRelease(room, ownerSocket)).toBe(true);

    // The second hold only gets what is left of the budget (10s), then is force-released
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    vi.advanceTimersByTime(10_000 - 1);
    expect(room.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(room.held).toBe(false);
    expect(events("hold-end")).toHaveLength(1);

    // Budget used up: no third hold this round
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
  });

  it("gives every round a fresh hold budget", () => {
    toScores();
    expect(engine.handleHold(room, ownerSocket)).toBe(true);
    vi.advanceTimersByTime(HOLD_SAFETY_TIMEOUT); // whole budget, force-released
    expect(engine.handleHold(room, ownerSocket)).toBe(false);
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);

    expect(room.phase).toBe("waiting-photo");
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
    expect(engine.handleHold(room, room.currentPlayer!.socketId)).toBe(true);
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

  it("pauses instead of looping when fewer than 2 players are connected, then ends when nobody returns", () => {
    room = setupStartedRoom(10);
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(GAME_START_DELAY);

    expect(events("game-paused")).toHaveLength(1);
    vi.advanceTimersByTime(PAUSE_TIMEOUT);
    expect(events("your-turn")).toHaveLength(0);
    expect(events("round-skipped")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(1);
    expect(room.phase).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses at the next round boundary when players go offline unnoticed, and ends when nobody returns", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    roomManager.markDisconnected(room.gameCode, "bob", "sock-bob");
    roomManager.markDisconnected(room.gameCode, "carol", "sock-carol");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(events("game-paused")).toHaveLength(1);
    expect(events("game-over")).toHaveLength(0);
    vi.advanceTimersByTime(PAUSE_TIMEOUT);
    expect(events("game-over")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`ends the game after ${MAX_CONSECUTIVE_SKIPS} consecutive skipped rounds and stops all timers`, () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));
    expect(roomEvents("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS - 1);
    expect(events("game-over")).toHaveLength(0);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(roomEvents("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS);
    expect(events("game-over")).toHaveLength(1);
    expect(room.phase).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * 10);
    expect(roomEvents("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS);
  });

  it("a played round resets the consecutive skip counter", () => {
    room = setupStartedRoom(10);
    vi.advanceTimersByTime(GAME_START_DELAY);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));
    playFullRound();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT * (MAX_CONSECUTIVE_SKIPS - 1));

    expect(roomEvents("round-skipped")).toHaveLength((MAX_CONSECUTIVE_SKIPS - 1) * 2);
    expect(events("game-over")).toHaveLength(0);
    expect(room.phase).toBe("waiting-photo");
  });
});
