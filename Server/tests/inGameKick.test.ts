import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { PauseInfo, Player, Room, ScoreRound, WaitingPhotoData } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-425 / DEC-052 A: the host can remove a player during the game too. The kicked player goes exactly as one who
// leaves (EXP-377): still one of the round's options until the next photo wait, scored as its answer if they owned
// the photo (DEC-038, DEC-040), the awaited photo handed on to someone else, the pause waiting for fewer players, and
// the game over when fewer than 2 are left. The room hears `player-removed` instead of `player-left`.

const GAME_START_DELAY = 1_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const NEXT_PHOTO = "/temp/" + "b".repeat(32) + ".jpg";
// Math.random just below 1: the owner is the last candidate, never the host (the room's first player)
const LAST_CANDIDATE = 0.999;

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const lastArgs = <T>(name: string) => events(name).pop()?.args[0] as T | undefined;
const player = (name: string) => room.players.find((p) => p.username === name);
const names = () => room.players.map((p) => p.username);
const optionNames = () => engine.snapshot(room).roundOptions.map((p) => p.username);

/** `names[0]` hosts a started game, at its first photo wait. */
function startedRoom(playerNames: string[]): Room {
  const r = rm.createRoom(playerNames[0], `sock-${playerNames[0]}`);
  for (const n of playerNames.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  r.rounds = 3;
  engine.startGame(r);
  r.players.forEach((p) => engine.markReady(r, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  expect(r.phase).toBe("waiting-photo");
  return r;
}

/** The awaited owner's photo starts the round's answering phase; returns that owner. */
function answering(photo = PHOTO): Player {
  const owner = room.currentPlayer!;
  engine.onPhotoReceived(room, photo, owner.username);
  expect(room.phase).toBe("answering");
  return owner;
}

/** remove-player from the host, as socketRoutes handles it (the sockets cut off are the route's business). */
const kick = (name: string) => engine.removePlayer(room, name, "kicked");

/** Socket disconnect as socketRoutes handles it. */
function drop(name: string): void {
  rm.markDisconnected(room.gameCode, name, player(name)!.socketId);
  engine.onConnectionChange(room);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(LAST_CANDIDATE);
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

describe("the host removes a player during the game (EXP-425)", () => {
  it("a player kicked while answering stays one of the round's options until the next photo wait (DEC-040)", () => {
    room = startedRoom(["alice", "bob", "carol", "dan"]);
    const owner = answering();
    expect(owner.username).toBe("dan");

    expect(kick("carol")).toMatchObject({ username: "carol" });
    expect(events("player-removed").map((e) => e.args[0])).toMatchObject([{ username: "carol" }]);
    expect(events("player-left")).toHaveLength(0);
    expect(names()).toEqual(["alice", "bob", "dan"]);
    expect(optionNames()).toEqual(["alice", "bob", "carol", "dan"]);

    // A pick on them is taken, and is a wrong guess, as before they were removed
    engine.recordAnswer(room, "bob", "carol");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    const scores = lastArgs<{ scores: ScoreRound[] }>("round-scores")!.scores;
    expect(scores.map((s) => s.username).sort()).toEqual(["alice", "bob", "dan"]);
    expect(scores.find((s) => s.username === "bob")).toMatchObject({ lastGuess: "carol", lastAnswerCorrect: false, points: 0 });

    // The game goes on without them: not an option of the next round
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(room).toMatchObject({ started: true, phase: "waiting-photo", round: 1 });
    expect(optionNames()).toEqual([]);
    answering(NEXT_PHOTO);
    expect(optionNames()).toEqual(["alice", "bob", "dan"]);
    engine.recordAnswer(room, "bob", "carol");
    expect(player("bob")).toMatchObject({ lastGuess: "" });
  });

  it("the round's photo owner kicked while answering stays its answer: guesses on them score (DEC-038)", () => {
    room = startedRoom(["alice", "bob", "carol", "dan"]);
    const owner = answering();
    engine.recordAnswer(room, "bob", owner.username);

    kick(owner.username);
    engine.recordAnswer(room, "carol", owner.username); // tapped after the kick

    vi.advanceTimersByTime(ANSWER_TIME);
    expect(lastArgs("round-reveal")).toMatchObject({ correctAnswer: owner.username });
    vi.advanceTimersByTime(REVEAL_TIME);
    const scores = lastArgs<{ scores: ScoreRound[] }>("round-scores")!.scores;
    expect(scores.map((s) => s.username)).not.toContain(owner.username);
    for (const guesser of ["bob", "carol"]) {
      expect(scores.find((s) => s.username === guesser)).toMatchObject({ lastAnswerCorrect: true, points: 1 });
    }
  });

  it("the owner kicked while their photo is awaited: another player is picked for the same round at once", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    vi.advanceTimersByTime(2_000);

    kick(owner.username);

    expect(events("round-skipped")).toHaveLength(0);
    expect(events("waiting-photo").map((e) => e.args[0] as WaitingPhotoData)).toEqual([
      { round: 1, duration: PHOTO_WAIT_TIMEOUT, gameNumber: 1 },
      { round: 1, duration: PHOTO_WAIT_TIMEOUT, gameNumber: 1 },
    ]);
    expect(room.currentPlayer).not.toBe(owner);
    expect(room.players).toContain(room.currentPlayer);
    expect(events("your-turn").pop()).toMatchObject({ target: room.currentPlayer!.socketId, args: [{ round: 1, attempt: 2 }] });
  });

  it("a kick that leaves fewer than 2 players ends the game at once", () => {
    room = startedRoom(["alice", "bob"]);
    answering();

    kick("bob");

    expect(events("game-over")).toHaveLength(1);
    expect(events("game-paused")).toHaveLength(0);
    expect(room).toMatchObject({ started: false, phase: null });
    expect(names()).toEqual(["alice"]);
  });

  it("during a pause: the pause waits for the others, and ends the game once nobody else can come back", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    answering();
    drop("bob");
    drop("carol");
    expect(lastArgs<PauseInfo>("game-paused")).toMatchObject({ waitingFor: ["bob", "carol"] });

    kick("bob");
    expect(lastArgs<PauseInfo>("game-paused")).toMatchObject({ waitingFor: ["carol"] });
    expect(room).toMatchObject({ started: true, paused: true });

    kick("carol");
    expect(events("game-over")).toHaveLength(1);
    expect(room.started).toBe(false);
  });

  it("the photo owner kicked while holding the scoreboard: the hold ends at once and the game goes on", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = answering();
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(engine.handleHold(room, owner.socketId)).toBe(true);

    kick(owner.username);

    expect(room.held).toBe(false);
    expect(events("hold-resume")).toHaveLength(1);
    expect(events("hold-end")).toHaveLength(1);
    // The hold ends before the room hears of the kick
    expect(emits.findIndex((e) => e.event === "hold-end")).toBeLessThan(emits.findIndex((e) => e.event === "player-removed"));
    vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
    expect(room).toMatchObject({ started: true, phase: "waiting-photo" });
  });

  it("never removes the host", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    answering();

    expect(kick("alice")).toBeUndefined();

    expect(events("player-removed")).toHaveLength(0);
    expect(names()).toEqual(["alice", "bob", "carol"]);
  });
});
