import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine } from "../managers/GameEngine";
import { MAX_PLAYERS_PER_ROOM, MAX_ROOMS, RoomManager } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// Room lifecycle: capacity, deletion of abandoned rooms, no surviving timers, per-game resets.

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;
const SOLO_ROOM_CLEANUP_DELAY = 2 * 60 * 1000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PAUSE_TIMEOUT = 5 * 60_000;
const PHOTO = "/temp/1700000000000-photo.jpg";

let emits: CapturedEmit[];
let rm: RoomManager;
let engine: GameEngine;

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

function lobby(): Room {
  const room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  return room;
}

/** alice + bob, game started and everyone ready; first round in waiting-photo. */
function startedRoom(rounds = 10): Room {
  const room = lobby();
  rm.setRounds(room.gameCode, rounds);
  engine.startGame(room);
  room.players.forEach((p) => (p.isReady = true));
  room.phase = "waiting-photo";
  engine.onAllPlayersReady(room);
  vi.advanceTimersByTime(GAME_START_DELAY);
  return room;
}

// ── Capacity (EXP-024) ─────────────────────────────────

describe("room capacity", () => {
  it(`accepts up to ${MAX_PLAYERS_PER_ROOM} players and rejects the next with "Room is full"`, () => {
    expect(MAX_PLAYERS_PER_ROOM).toBe(12);
    const room = rm.createRoom("p0", "s0");
    for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) expect(rm.joinRoom(room.gameCode, `p${i}`, `s${i}`).success).toBe(true);
    expect(room.players).toHaveLength(MAX_PLAYERS_PER_ROOM);
    expect(rm.joinRoom(room.gameCode, "extra", "s-extra")).toEqual({ success: false, message: "Room is full" });
    expect(room.players).toHaveLength(MAX_PLAYERS_PER_ROOM);
  });

  it("a player switching username in a full room does not count its own slot", () => {
    const room = rm.createRoom("p0", "s0");
    for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) rm.joinRoom(room.gameCode, `p${i}`, `s${i}`);
    expect(rm.joinRoom(room.gameCode, "renamed", "s4", undefined, "p4").success).toBe(true);
  });

  it("still lets an existing player rejoin a full room with their token", () => {
    const room = rm.createRoom("p0", "s0");
    for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) rm.joinRoom(room.gameCode, `p${i}`, `s${i}`);
    const token = room.players[3].rejoinToken;
    rm.markDisconnected(room.gameCode, "p3", "s3");
    expect(rm.joinRoom(room.gameCode, "p3", "s3-new", token)).toMatchObject({ success: true, rejoin: true });
  });
});

// ── Abandoned rooms (EXP-026) ──────────────────────────

describe("abandoned rooms", () => {
  it("deletes a room 30 min after its last connected player disconnects", () => {
    const room = lobby();
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBe(room); // bob still connected

    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    vi.advanceTimersByTime(1);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejoin cancels the deletion; disconnecting again schedules a single new one", () => {
    const room = lobby();
    const bobToken = room.players[1].rejoinToken;
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY / 2);

    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob-2", bobToken).success).toBe(true);
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    expect(vi.getTimerCount()).toBe(0);

    rm.markDisconnected(room.gameCode, "bob", "sock-bob-2");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("schedules deletion when the last connected player leaves and only disconnected ones remain", () => {
    const room = lobby();
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    rm.removePlayer(room.gameCode, "alice");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("does not stack deletion timers (disconnect all, then the last one leaves)", () => {
    const room = lobby();
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    rm.removePlayer(room.gameCode, "bob");
    rm.removePlayer(room.gameCode, "alice");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a running game with nobody connected pauses at the next boundary, ends after the pause and leaves only the deletion timer (waiting-photo)", () => {
    const room = startedRoom();
    expect(room.phase).toBe("waiting-photo");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(PAUSE_TIMEOUT);
    expect(emits.some((e) => e.event === "game-over")).toBe(true);
    expect(room._timer).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // the room deletion

    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a running game with nobody connected pauses at the next boundary, ends after the pause and leaves only the deletion timer (answering)", () => {
    const room = startedRoom();
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    expect(room.phase).toBe("answering");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");

    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME + PAUSE_TIMEOUT);
    expect(emits.some((e) => e.event === "game-over")).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("deleting a room with a running game clears its game timers", () => {
    const room = startedRoom();
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    // Simulate a game timer still pending when the deletion fires
    clearTimeout(room._timer!);
    room._timer = setTimeout(() => {}, ROOM_CLEANUP_DELAY * 2);
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("failed joins do not keep abandoned rooms alive", () => {
  it("started room: an outsider's rejected join does not cancel the deletion", () => {
    const room = lobby();
    engine.startGame(room); // everyone goes offline before im-ready
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    // still in the ready phase (the ready timeout ends this game, as nobody is connected)
    vi.advanceTimersByTime(5_000);
    expect(rm.joinRoom(room.gameCode, "mallory", "sock-m")).toEqual({ success: false, message: "Game already started" });
    expect(rm.joinRoom(room.gameCode, "bob", "sock-m", "wrong-token")).toMatchObject({ success: false });
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 5_000);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("full room: a rejected join does not cancel the deletion", () => {
    const room = rm.createRoom("p0", "s0");
    for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) rm.joinRoom(room.gameCode, `p${i}`, `s${i}`);
    room.players.forEach((p) => rm.markDisconnected(room.gameCode, p.username, p.socketId));
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY / 2);
    expect(rm.joinRoom(room.gameCode, "extra", "s-extra")).toEqual({ success: false, message: "Room is full" });
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY / 2);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });
});

describe("solo rooms and global cap (EXP-034)", () => {
  it("a room that never had a second player is deleted 2 min after it is abandoned", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    vi.advanceTimersByTime(SOLO_ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    vi.advanceTimersByTime(1);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("an emptied solo room (creator left) also uses the 2 min delay", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.removePlayer(room.gameCode, "alice");
    vi.advanceTimersByTime(SOLO_ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("a room that had a second player keeps the 30 min delay even after the guest left", () => {
    const room = lobby();
    rm.removePlayer(room.gameCode, "bob");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    vi.advanceTimersByTime(SOLO_ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - SOLO_ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it(`reports capacity once ${MAX_ROOMS} rooms exist`, () => {
    expect(MAX_ROOMS).toBe(5000);
    for (let i = 0; i < MAX_ROOMS - 1; i++) rm.createRoom(`u${i}`, `s${i}`);
    expect(rm.isAtCapacity()).toBe(false);
    rm.createRoom("last", "s-last");
    expect(rm.isAtCapacity()).toBe(true);
    expect(rm.stats().rooms).toBe(MAX_ROOMS);
  });

  it("safeRoomData does not expose the guests flag", () => {
    expect(rm.safeRoomData(lobby())).not.toHaveProperty("_hadGuests");
  });
});

// ── Teardown (EXP-020) ─────────────────────────────────

describe("clear", () => {
  it("removes every room and leaves no live timers", () => {
    const a = startedRoom();
    const b = lobby();
    rm.removePlayer(b.gameCode, "alice");
    rm.removePlayer(b.gameCode, "bob"); // b pending deletion
    expect(vi.getTimerCount()).toBeGreaterThan(1);

    rm.clear();
    expect(rm.stats()).toEqual({ rooms: 0, pendingDeletions: 0 });
    expect(rm.getRoom(a.gameCode)).toBeUndefined();
    expect(rm.getRoom(b.gameCode)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Play again (EXP-031) ───────────────────────────────

describe("play again", () => {
  /** 1-round game where alice planted a photo that was never shown; the guesser scores. */
  function finishedGameWithLeftovers(): { room: Room; guesser: string } {
    const room = startedRoom(1);
    const alice = room.players[0];
    alice.hasPlantedPhoto = true;
    alice.plantedPhoto = PHOTO; // planted after the slots were assigned → never shown
    const owner = room.currentPlayer!.username;
    const guesser = owner === "alice" ? "bob" : "alice";
    engine.onPhotoReceived(room, PHOTO, owner);
    engine.recordAnswer(room, guesser, owner);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    return { room, guesser };
  }

  it("game-over still reports the final points, then clears leftover planted photos", () => {
    const { room, guesser } = finishedGameWithLeftovers();
    const over = emits.find((e) => e.event === "game-over")!;
    const finalScore = (over.args[0] as { finalScore: { username: string; points: number }[] }).finalScore;
    expect(finalScore.find((s) => s.username === guesser)!.points).toBe(1);
    for (const p of room.players) {
      expect(p.hasPlantedPhoto).toBeFalsy();
      expect(p.plantedPhoto).toBeUndefined();
    }
  });

  it("startGame resets points and answers from the previous game", () => {
    const { room, guesser } = finishedGameWithLeftovers();
    expect(room.players.find((p) => p.username === guesser)!.points).toBe(1);

    emits.length = 0;
    engine.startGame(room);
    for (const p of room.players) expect(p).toMatchObject({ points: 0, lastGuess: "", lastAnswerCorrect: false });
    const started = emits.find((e) => e.event === "game-started")!;
    for (const p of started.args[0] as { points: number; hasPlantedPhoto?: boolean }[]) {
      expect(p.points).toBe(0);
      expect(p.hasPlantedPhoto).toBeFalsy();
    }
  });

  it("a photo planted for the next game (after game-over) is kept by startGame", () => {
    const { room } = finishedGameWithLeftovers();
    room.players[1].plantedPhoto = PHOTO;
    engine.startGame(room);
    expect(room.players[1].plantedPhoto).toBe(PHOTO);
  });
});
