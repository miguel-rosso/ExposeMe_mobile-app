import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { PLANTED_DELAY_MAX } from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-017 / EXP-027: every player list sent to clients goes through one allowlist (no socketId, rejoinToken,
// plantedPhoto), and the answers of the round in play stay hidden until round-scores (same rule as the snapshot).

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const PUBLIC_KEYS = ["connected", "isHost", "lastAnswerCorrect", "lastGuess", "points", "username"];

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

/** Every key (at any depth) in a JSON-serialised payload. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}

function expectNoSecrets(payload: unknown): void {
  const json = JSON.stringify(payload);
  const keys = keysDeep(JSON.parse(json));
  for (const k of ["socketId", "rejoinToken", "plantedPhoto"]) expect(keys.has(k), `payload has "${k}": ${json}`).toBe(false);
  for (const p of room.players) {
    expect(json).not.toContain(p.socketId);
    expect(json).not.toContain(p.rejoinToken);
  }
  expect(json).not.toContain(PLANTED);
}

function setup(names: string[]): Room {
  const r = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  return r;
}

/** Started game in `answering`, with a photo from the picked owner. */
function answeringRoom(): Room {
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  // Round 1 may be a planted round: a photo wait with no owner, then round-start within PLANTED_DELAY_MAX (EXP-126)
  if (!room.currentPlayer) vi.advanceTimersByTime(PLANTED_DELAY_MAX);
  else engine.onPhotoReceived(room, PHOTO, room.currentPlayer.username);
  expect(room.phase).toBe("answering");
  return room;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
  room = setup(["alice", "bob", "carol"]);
});

afterEach(() => {
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("public player data", () => {
  it("publicPlayer keeps only the allowlisted fields", () => {
    const bob = room.players[1];
    bob.plantedPhoto = PLANTED;
    bob.hasPlantedPhoto = true;
    expect(Object.keys(rm.publicPlayer(bob)).sort()).toEqual(PUBLIC_KEYS);
    expectNoSecrets(rm.publicPlayer(bob));
  });

  it("room-of-game strips every player's planted photo, socket id and token (not only the owner's)", () => {
    room.players[1].plantedPhoto = PLANTED; // bob planted, alice is the current owner
    room.players[1].hasPlantedPhoto = true;
    room.currentPlayer = room.players[0];
    const safe = rm.safeRoomData(room);
    expectNoSecrets(safe);
    expect(safe.players.map((p) => Object.keys(p).sort())).toEqual(room.players.map(() => PUBLIC_KEYS));
    // Whether bob planted a photo is his own business (EXP-126): told only to him, in room-of-game
    expect(safe.players[1]).not.toHaveProperty("hasPlantedPhoto");
  });

  it("room-of-game never names the photo owner while the photo is awaited", () => {
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.phase).toBe("waiting-photo");
    const json = JSON.stringify(rm.safeRoomData(room));
    expect(json).not.toContain("currentPlayer");
    expect(rm.safeRoomData(room)).toMatchObject({ phase: "waiting-photo", started: true });
  });

  it("game-started sends players without socket ids, tokens or planted photos", () => {
    room.players[2].plantedPhoto = PLANTED;
    engine.startGame(room);
    const ev = emits.find((e) => e.event === "game-started")!;
    expectNoSecrets(ev.args);
    expect((ev.args[0] as object[]).map((p) => Object.keys(p).sort())).toEqual(room.players.map(() => PUBLIC_KEYS));
  });

  it("game-state snapshot players have only public fields", () => {
    room.players[1].plantedPhoto = PLANTED;
    answeringRoom();
    const snap: GameStateSnapshot = engine.gameStateFor(room, room.players[0]);
    expectNoSecrets({ ...snap, photo: null });
    expect(snap.players.map((p) => Object.keys(p).sort())).toEqual(room.players.map(() => PUBLIC_KEYS));
  });
});

describe("answers of the round in play stay hidden until round-scores", () => {
  it("room-of-game hides guesses and the round's point in answering and reveal, shows them in scores", () => {
    answeringRoom();
    const owner = room.currentPlayer!.username;
    const guesser = room.players.find((p) => p.username !== owner)!;
    engine.recordAnswer(room, guesser.username, owner);
    expect(guesser.points).toBe(1);

    const hidden = (phase: string) => {
      expect(room.phase).toBe(phase);
      const pub = rm.safeRoomData(room).players.find((p) => p.username === guesser.username)!;
      expect(pub).toMatchObject({ points: 0, lastGuess: "", lastAnswerCorrect: false });
    };
    hidden("answering");
    vi.advanceTimersByTime(ANSWER_TIME);
    hidden("reveal");
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(room.phase).toBe("scores");
    const shown = rm.safeRoomData(room).players.find((p) => p.username === guesser.username)!;
    expect(shown).toMatchObject({ points: 1, lastGuess: owner, lastAnswerCorrect: true });
  });

  it("game-over in the middle of a round doesn't count (or reveal) that round's answers", () => {
    answeringRoom();
    const owner = room.currentPlayer!.username;
    const guesser = room.players.find((p) => p.username !== owner)!;
    engine.recordAnswer(room, guesser.username, owner);
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    // Everyone else leaves: nobody can come back, the game ends during reveal
    for (const p of room.players.filter((x) => x !== guesser).map((x) => x.username)) rm.removePlayer(room.gameCode, p);
    engine.onConnectionChange(room);
    const over = emits.find((e) => e.event === "game-over")!;
    expect(over).toBeDefined();
    const { finalScore } = over.args[0] as { finalScore: { username: string }[] };
    expect(finalScore).toEqual([expect.objectContaining({ username: guesser.username, points: 0, lastGuess: "", lastAnswerCorrect: false })]);
    expect(guesser.points).toBe(0); // the later game-state snapshot (game over) agrees with game-over
  });

  // EXP-148 security check: the EXP-017 rollback in endGame also covers a game that ends during answering, after a
  // re-selected pick (only the last pick's point is in play, and it is dropped)
  it("game-over during answering doesn't count (or reveal) that round's picks", () => {
    answeringRoom();
    const owner = room.currentPlayer!.username;
    const guesser = room.players.find((p) => p.username !== owner)!;
    const other = room.players.find((p) => p !== guesser && p.username !== owner)!;
    engine.recordAnswer(room, guesser.username, other.username);
    engine.recordAnswer(room, guesser.username, owner);
    expect(guesser.points).toBe(1);
    for (const p of room.players.filter((x) => x !== guesser).map((x) => x.username)) rm.removePlayer(room.gameCode, p);
    engine.onConnectionChange(room);
    const over = emits.find((e) => e.event === "game-over")!;
    expect(over).toBeDefined();
    const { finalScore } = over.args[0] as { finalScore: unknown[] };
    expect(finalScore).toEqual([expect.objectContaining({ username: guesser.username, points: 0, lastGuess: "", lastAnswerCorrect: false })]);
    expect(guesser.points).toBe(0);
  });

  it("game-over after round-scores keeps the round's answers and points", () => {
    answeringRoom();
    const owner = room.currentPlayer!.username;
    const guesser = room.players.find((p) => p.username !== owner)!;
    engine.recordAnswer(room, guesser.username, owner);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
    for (const p of room.players.filter((x) => x !== guesser).map((x) => x.username)) rm.removePlayer(room.gameCode, p);
    engine.onConnectionChange(room);
    const { finalScore } = emits.find((e) => e.event === "game-over")!.args[0] as { finalScore: unknown[] };
    expect(finalScore).toEqual([expect.objectContaining({ username: guesser.username, points: 1, lastGuess: owner, lastAnswerCorrect: true })]);
  });

  it("new-host / player-removed payloads use the same rule (publicPlayers)", () => {
    answeringRoom();
    const owner = room.currentPlayer!.username;
    const guesser = room.players.find((p) => p.username !== owner)!;
    engine.recordAnswer(room, guesser.username, owner);
    const pub = rm.publicPlayer(guesser, room);
    expect(pub).toMatchObject({ points: 0, lastGuess: "", lastAnswerCorrect: false });
  });
});

describe("remove-player by username", () => {
  it("removePlayerByUsername removes the player and returns it", () => {
    const removed = rm.removePlayerByUsername(room.gameCode, "carol");
    expect(removed?.username).toBe("carol");
    expect(room.players.map((p) => p.username)).toEqual(["alice", "bob"]);
    expect(rm.removePlayerByUsername(room.gameCode, "carol")).toBeUndefined();
  });
});
