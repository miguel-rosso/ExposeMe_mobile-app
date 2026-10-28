import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-230: round-reveal tells each player the answer the server recorded for them when answers froze (`yourGuess`),
// so the reveal colours the pick that counted, not a late change that arrived after the freeze. It is per recipient:
// nobody gets anyone else's guess before round-scores. A rejoin during the reveal gets the same in its snapshot.

const GAME_START_DELAY = 1_000;
const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const PHOTO = "/temp/" + "c".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const player = (name: string) => room.players.find((p) => p.username === name)!;
const guessers = () => room.players.filter((p) => p !== room.currentPlayer);

/** alice, bob and carol in round 1's answering phase (the owner is whoever was picked). */
function answeringRoom(): Player {
  room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  rm.joinRoom(room.gameCode, "carol", "sock-carol");
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  room.plantedSlots = new Set();
  vi.advanceTimersByTime(GAME_START_DELAY);
  const owner = room.currentPlayer!;
  engine.onPhotoReceived(room, PHOTO, owner.username);
  return owner;
}

function revealTo(p: Player): unknown[] {
  return emits.filter((e) => e.event === "round-reveal" && e.target === p.socketId).map((e) => e.args[0]);
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

describe("round-reveal carries each player's recorded answer (EXP-230)", () => {
  it("sends each player only their own guess as frozen, a change arriving after the freeze included", () => {
    const owner = answeringRoom();
    const [right, wrong] = guessers();
    engine.recordAnswer(room, right.username, wrong.username);
    engine.recordAnswer(room, right.username, owner.username); // last change in time: this one counts
    engine.recordAnswer(room, wrong.username, right.username);
    engine.recordAnswer(room, owner.username, owner.username); // the owner votes too (self-vote counts)
    vi.advanceTimersByTime(ANSWER_TIME);
    engine.recordAnswer(room, wrong.username, owner.username); // left the phone in time, arrived after the freeze

    const reveal = (yourGuess: string) => [{ correctAnswer: owner.username, duration: REVEAL_TIME, yourGuess }];
    expect(revealTo(right)).toEqual(reveal(owner.username));
    expect(revealTo(wrong)).toEqual(reveal(right.username));
    expect(revealTo(owner)).toEqual(reveal(owner.username));
    // Nothing room-wide: no socket can read another player's guess
    expect(emits.filter((e) => e.event === "round-reveal" && e.target === room.gameCode)).toEqual([]);
  });

  it("sends an empty guess to a player who didn't answer, or withdrew their pick", () => {
    answeringRoom();
    const [silent, withdrew] = guessers();
    engine.recordAnswer(room, withdrew.username, silent.username);
    engine.recordAnswer(room, withdrew.username, "");
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(revealTo(silent)).toMatchObject([{ yourGuess: "" }]);
    expect(revealTo(withdrew)).toMatchObject([{ yourGuess: "" }]);
  });

  it("puts the rejoiner's own recorded answer in a reveal or scores snapshot, never before the reveal", () => {
    const owner = answeringRoom();
    const bob = player("bob");
    const guess = bob === owner ? "alice" : owner.username;
    engine.recordAnswer(room, bob.username, guess);
    expect(engine.gameStateFor(room, bob).yourGuess).toBeNull(); // answering: not final, not sent

    vi.advanceTimersByTime(ANSWER_TIME);
    // Rejoin on a new socket as socketRoutes handles it
    expect(rm.joinRoom(room.gameCode, bob.username, "sock-bob-2", bob.rejoinToken)).toMatchObject({ rejoin: true });
    engine.onPlayerRejoined(room, bob);
    const snap = emits.filter((e) => e.event === "game-state" && e.target === "sock-bob-2").pop()!.args[0] as GameStateSnapshot;
    expect(snap).toMatchObject({ phase: "reveal", correctAnswer: owner.username, yourGuess: guess });
    // Someone else's snapshot carries their own (empty) answer, not bob's
    const other = room.players.find((p) => p !== bob && p !== owner)!;
    expect(engine.gameStateFor(room, other).yourGuess).toBe("");

    vi.advanceTimersByTime(REVEAL_TIME);
    expect(engine.gameStateFor(room, bob)).toMatchObject({ phase: "scores", yourGuess: guess });
  });
});
