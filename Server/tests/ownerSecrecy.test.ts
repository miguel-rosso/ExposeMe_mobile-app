import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto, receivedBy } from "./helpers";

// EXP-128 / EXP-252: nobody is told whose photo it is before round-reveal, not even the owner (they may not recognise
// it and play like everyone else): round-start and the game-state snapshot are the same for every recipient, uploaded
// and planted photos alike. The owner's answer is recorded and scored like any other; only from the reveal on
// (correctAnswer) can the owner tell it was theirs, and only then can they hold the scores screen.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg";
const PLANTED = "/temp/fedcba9876543210fedcba9876543210.jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

const NAMES = ["alice", "bob", "carol"];

/** Strings anywhere in a payload (keys and values). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

/**
 * Owner identity leaks in what `p` received (round-start, answering game-state) since emit index `since`: an
 * `owner` or `isOwner` key, or the owner's name outside the player lists.
 */
function leaksFor(p: Player, ownerName: string, since: number): string[] {
  const out: string[] = [];
  for (const e of receivedBy(emits.slice(since), p.socketId, room.gameCode)) {
    if (e.event !== "round-start" && e.event !== "game-state") continue;
    const data = e.args[0] as Record<string, unknown>;
    if (e.event === "game-state" && data.phase !== "answering") continue;
    if ("owner" in data) out.push(`${p.username} ${e.event}: owner key`);
    if ("isOwner" in data) out.push(`${p.username} ${e.event}: isOwner key`);
    const { players: _players, scores: _scores, ...rest } = data;
    if (strings(rest).includes(ownerName)) out.push(`${p.username} ${e.event}: owner name`);
  }
  return out;
}

function setup(plantedBy?: string): void {
  room = roomManager.createRoom("alice", "sock-alice");
  roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
  roomManager.joinRoom(room.gameCode, "carol", "sock-carol");
  if (plantedBy) {
    plantPhoto(room.gameCode, room.players.find((p) => p.username === plantedBy)!, PLANTED);
    room.rounds = 1; // the only round is the planted one
  }
  engine.startGame(room);
  room.players.forEach((p) => (p.isReady = true));
  room.phase = "waiting-photo";
  engine.onAllPlayersReady(room);
  vi.advanceTimersByTime(GAME_START_DELAY);
  // A planted round starts after a short photo wait (EXP-126, at most 3 s)
  if (plantedBy) vi.advanceTimersByTime(3_000);
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

describe("photo owner secrecy before the reveal (EXP-128, EXP-252)", () => {
  it("uploaded photo: one room-wide round-start, the same for everyone, owner included", () => {
    setup();
    const owner = room.currentPlayer!;
    const since = emits.length;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    for (const p of room.players) {
      const starts = receivedBy(emits.slice(since), p.socketId, room.gameCode).filter((e) => e.event === "round-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].args[0]).toEqual({ photo: PHOTO, round: 1, duration: ANSWER_TIME - ANSWER_GRACE });
    }
    expect(emits.slice(since).filter((e) => e.event === "round-start")).toEqual([
      { target: room.gameCode, event: "round-start", args: [{ photo: PHOTO, round: 1, duration: ANSWER_TIME - ANSWER_GRACE }] },
    ]);
    expect(room.players.flatMap((p) => leaksFor(p, owner.username, since))).toEqual([]);
  });

  it("planted photo: nobody, the planter included, is told whose photo it is", () => {
    setup("carol");
    const carol = room.players.find((p) => p.username === "carol")!;
    expect(room.currentPlayer).toBe(carol);
    expect(room.phase).toBe("answering");
    for (const p of room.players) {
      const starts = receivedBy(emits, p.socketId, room.gameCode).filter((e) => e.event === "round-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].args[0]).toEqual({ photo: PLANTED, round: 1, duration: ANSWER_TIME - ANSWER_GRACE });
    }
    expect(room.players.flatMap((p) => leaksFor(p, "carol", 0))).toEqual([]);
  });

  it("game-state on rejoin: the same for everyone (no isOwner), no owner name until reveal", () => {
    setup();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(2_000);
    const since = emits.length;
    // Everyone (owner included) re-sends their join on the same socket while answering
    for (const p of room.players) engine.resendState(room, p);
    for (const p of room.players) {
      const snaps = receivedBy(emits.slice(since), p.socketId, room.gameCode).filter((e) => e.event === "game-state");
      expect(snaps).toHaveLength(1);
      expect(snaps[0].args[0]).toMatchObject({ phase: "answering", photo: PHOTO, correctAnswer: null });
      expect(snaps[0].args[0]).not.toHaveProperty("owner");
      expect(snaps[0].args[0]).not.toHaveProperty("isOwner");
    }
    expect(room.players.flatMap((p) => leaksFor(p, owner.username, since))).toEqual([]);

    // A non-owner and the owner rejoining on new sockets: same rule
    for (const p of [room.players.find((x) => x !== owner)!, owner]) {
      p.socketId = `${p.socketId}-2`;
      const before = emits.length;
      engine.onPlayerRejoined(room, p);
      const snap = receivedBy(emits.slice(before), p.socketId, room.gameCode).find((e) => e.event === "game-state")!;
      expect(snap.args[0]).toMatchObject({ phase: "answering", correctAnswer: null });
      expect(leaksFor(p, owner.username, before)).toEqual([]);
    }

    // From the reveal on, the answer is public (correctAnswer): that is how the owner learns it was theirs
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    expect(engine.snapshot(room)).toMatchObject({ correctAnswer: owner.username });
    expect(engine.snapshot(room)).not.toHaveProperty("isOwner");
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(engine.snapshot(room)).toMatchObject({ phase: "scores", correctAnswer: owner.username });
  });

  // The snapshot's scores order must not tell who guessed right (and so whose photo it is): a hidden correct guess
  // doesn't lift a player past the ones tied with them, the owner's own vote included (EXP-252)
  it("game-state scores keep the tied players' fixed order while the round's answers are hidden", () => {
    setup();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    // The last-joined player guesses right (the owner's self-vote when carol owns it); all tied at 0 points shown
    engine.recordAnswer(room, "carol", owner.username);
    const order = () => engine.snapshot(room).scores.map((s) => s.username);
    expect(order()).toEqual(NAMES);
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    expect(order()).toEqual(NAMES);
    // From round-scores on the point is public: carol moves up
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(order()[0]).toBe("carol");
  });

  it("no player name appears in waiting-photo or round-start payloads", () => {
    setup();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    const payloads = emits.filter((e) => e.event === "round-start" || e.event === "waiting-photo").map((e) => e.args);
    for (const n of NAMES) expect(strings(payloads)).not.toContain(n);
  });
});

describe("the photo owner plays like everyone (EXP-252)", () => {
  type ScoreRow = { username: string; points: number; lastGuess: string; lastAnswerCorrect: boolean };
  const scoreOf = (name: string) => {
    const last = emits.filter((e) => e.event === "round-scores").pop()!.args[0] as { scores: ScoreRow[] };
    return last.scores.find((row) => row.username === name)!;
  };

  it("the owner's answer is recorded and scored: their own name is a correct guess", () => {
    setup();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    engine.recordAnswer(room, owner.username, owner.username);
    expect(owner).toMatchObject({ lastGuess: owner.username, lastAnswerCorrect: true, points: 1 });
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(room.phase).toBe("scores");
    expect(scoreOf(owner.username)).toMatchObject({ lastGuess: owner.username, lastAnswerCorrect: true, points: 1 });
  });

  it("an owner who doesn't recognise their photo scores like any wrong guess, and can change it", () => {
    setup();
    const owner = room.currentPlayer!;
    const other = room.players.find((p) => p !== owner)!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    engine.recordAnswer(room, owner.username, owner.username);
    engine.recordAnswer(room, owner.username, other.username); // the last pick replaces the first and its point
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(scoreOf(owner.username)).toMatchObject({ lastGuess: other.username, lastAnswerCorrect: false, points: 0 });
  });

  it("a planter's answer counts too", () => {
    setup("carol");
    engine.recordAnswer(room, "carol", "carol");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
    expect(scoreOf("carol")).toMatchObject({ lastGuess: "carol", lastAnswerCorrect: true, points: 1 });
  });

  it("only the owner can hold, and only in scores (after the reveal)", () => {
    setup();
    const owner = room.currentPlayer!;
    const other = room.players.find((p) => p !== owner)!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    expect(engine.handleHold(room, owner.socketId)).toBe(false); // answering
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(engine.handleHold(room, owner.socketId)).toBe(false); // reveal
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(engine.handleHold(room, other.socketId)).toBe(false);
    expect(engine.handleHold(room, owner.socketId)).toBe(true);
  });
});
