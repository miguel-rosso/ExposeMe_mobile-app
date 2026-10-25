import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, registerUpload } from "./helpers";

// EXP-129 (DEC-016 A): a game start drops every disconnected player from the room, so "Play again" has no ghosts
// (answer options, tied winners with 0). If they come back they join as new players.

const ANSWER_TIME = 8_000;
const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg";
const GHOST_PHOTO = "/temp/fedcba9876543210fedcba9876543210.jpg";

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
  rm.clear();
  uploadStore.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function lobby(names: string[]): Room {
  const room = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(room.gameCode, n, `sock-${n}`);
  return room;
}

const names = (room: Room) => room.players.map((p) => p.username);
const events = (event: string) => emits.filter((e) => e.event === event);

describe("game start removes disconnected players (EXP-129)", () => {
  it("first game: a player disconnected in the lobby is removed, player-left goes out before game-started", () => {
    const room = lobby(["alice", "bob", "carol"]);
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    expect(engine.startGame(room)).toBe(true);
    expect(names(room)).toEqual(["alice", "bob"]);
    const left = events("player-left");
    expect(left.map((e) => e.args[0])).toEqual(["carol"]);
    expect(emits.indexOf(left[0])).toBeLessThan(emits.findIndex((e) => e.event === "game-started"));
    const started = events("game-started")[0].args[0] as { username: string }[];
    expect(started.map((p) => p.username)).toEqual(["alice", "bob"]);
  });

  it("play again: whoever disconnected at the end of the previous game is gone, and is never an answer or winner", () => {
    const room = lobby(["alice", "bob", "carol"]);
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    // carol drops; the game goes on with alice and bob and ends (fewer rounds via skips is enough here)
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.onConnectionChange(room);
    room.rounds = room.round + 1;
    const owner = room.currentPlayer!;
    registerUpload(room.gameCode, owner.username, PHOTO);
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(ANSWER_TIME + 3_000 + 5_000);
    expect(room.started).toBe(false);

    emits.length = 0;
    engine.startGame(room);
    expect(names(room)).toEqual(["alice", "bob"]);
    expect(events("player-left").map((e) => e.args[0])).toEqual(["carol"]);
    const started = events("game-started")[0].args[0] as { username: string }[];
    expect(started.map((p) => p.username)).not.toContain("carol");
  });

  it("hands the host over (new-host) when the host is the disconnected one", () => {
    const room = lobby(["alice", "bob", "carol"]);
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    expect(engine.startGame(room)).toBe(true);
    expect(names(room)).toEqual(["bob", "carol"]);
    expect(room.players[0].isHost).toBe(true);
    const nh = events("new-host");
    expect(nh).toHaveLength(1);
    expect(nh[0].args[0]).toMatchObject({ username: "bob", isHost: true });
    expect(nh[0].args[0]).not.toHaveProperty("rejoinToken");
  });

  it("releases the removed player's uploads (planted photo included)", () => {
    const room = lobby(["alice", "bob", "carol"]);
    registerUpload(room.gameCode, "carol", GHOST_PHOTO);
    registerUpload(room.gameCode, "bob", PHOTO);
    room.players[2].plantedPhoto = GHOST_PHOTO;
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.startGame(room);
    expect(uploadStore.get(GHOST_PHOTO.slice("/temp/".length))).toBeUndefined();
    expect(uploadStore.get(PHOTO.slice("/temp/".length))).toBeDefined();
  });

  it("a removed player coming back with the old token joins as a new player (new token, player-joined path)", () => {
    const room = lobby(["alice", "bob", "carol"]);
    const oldToken = room.players[2].rejoinToken;
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    engine.startGame(room);
    // Game in progress: the old token no longer rejoins
    expect(rm.joinRoom(room.gameCode, "carol", "sock-carol2", oldToken)).toEqual({ success: false, message: "Game already started" });
    expect(rm.authenticate(room.gameCode, oldToken)).toBeNull();
    // Back in the lobby (after game-over) the name is free: a fresh player, not a rejoin
    room.started = false;
    room.phase = null;
    const res = rm.joinRoom(room.gameCode, "carol", "sock-carol2", oldToken);
    expect(res).toMatchObject({ success: true });
    expect(res.rejoin).toBeUndefined();
    const carol = rm.getPlayer(room.gameCode, "carol")!;
    expect(carol.rejoinToken).not.toBe(oldToken);
    expect(carol.points).toBe(0);
  });

  it("refuses to start when fewer than 2 players are left after the cleanup (lobby list still updated)", () => {
    const room = lobby(["alice", "bob"]);
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    expect(engine.startGame(room)).toBe(false);
    expect(room.started).toBe(false);
    expect(names(room)).toEqual(["alice"]);
    expect(events("player-left").map((e) => e.args[0])).toEqual(["bob"]);
    expect(events("game-started")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("connected players are untouched", () => {
    const room = lobby(["alice", "bob", "carol"]);
    engine.startGame(room);
    expect(names(room)).toEqual(["alice", "bob", "carol"]);
    expect(events("player-left")).toHaveLength(0);
    expect(events("new-host")).toHaveLength(0);
  });
});

describe("no guess is stored as an empty string (EXP-132)", () => {
  function answering(): Room {
    const room = lobby(["alice", "bob", "carol"]);
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    const owner = room.currentPlayer!;
    registerUpload(room.gameCode, owner.username, PHOTO);
    engine.onPhotoReceived(room, PHOTO, owner.username);
    return room;
  }

  it("an empty guess is recorded as \"\" (never an English placeholder); a guess once the reveal shows the owner is ignored", () => {
    const room = answering();
    const owner = room.currentPlayer!;
    const guesser = room.players.find((p) => p !== owner)!;
    engine.recordAnswer(room, guesser.username, "");
    expect(guesser.lastGuess).toBe("");
    // Answers freeze when answering ends (EXP-148): a guess sent during the reveal is ignored
    vi.advanceTimersByTime(ANSWER_TIME);
    engine.recordAnswer(room, guesser.username, owner.username);
    expect(guesser.lastGuess).toBe("");
    expect(guesser.lastAnswerCorrect).toBe(false);
    expect(guesser.points).toBe(0);
  });

  it("round-scores never contain \"(no guess)\"", () => {
    const room = answering();
    const guesser = room.players.find((p) => p !== room.currentPlayer)!;
    engine.recordAnswer(room, guesser.username, "");
    vi.advanceTimersByTime(ANSWER_TIME + 3_000);
    const scores = events("round-scores")[0].args[0] as { scores: { lastGuess: string }[] };
    expect(scores.scores.every((s) => s.lastGuess === "")).toBe(true);
  });

  it("the next round accepts answers again", () => {
    const room = answering();
    const guesser = room.players.find((p) => p !== room.currentPlayer)!;
    engine.recordAnswer(room, guesser.username, "");
    vi.advanceTimersByTime(ANSWER_TIME + 3_000 + 5_000);
    const owner = room.currentPlayer!;
    const next = "/temp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg";
    registerUpload(room.gameCode, owner.username, next);
    engine.onPhotoReceived(room, next, owner.username);
    const voter = room.players.find((p) => p !== owner)!;
    engine.recordAnswer(room, voter.username, owner.username);
    expect(voter.lastGuess).toBe(owner.username);
    expect(voter.lastAnswerCorrect).toBe(true);
  });
});
