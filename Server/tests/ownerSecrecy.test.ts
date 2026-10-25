import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_GRACE, GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, receivedBy } from "./helpers";

// EXP-128: the photo owner's identity never reaches anyone but the owner before round-reveal: round-start and the
// game-state snapshot are per recipient (`isOwner` only true for the owner), uploaded and planted photos alike.

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
 * `owner` key, the owner's name outside the player lists, or `isOwner` not matching whether `p` is the owner.
 */
function leaksFor(p: Player, ownerName: string, since: number): string[] {
  const out: string[] = [];
  for (const e of receivedBy(emits.slice(since), p.socketId, room.gameCode)) {
    if (e.event !== "round-start" && e.event !== "game-state") continue;
    const data = e.args[0] as Record<string, unknown>;
    if (e.event === "game-state" && data.phase !== "answering") continue;
    if ("owner" in data) out.push(`${p.username} ${e.event}: owner key`);
    const { players: _players, scores: _scores, ...rest } = data;
    if (strings(rest).includes(ownerName)) out.push(`${p.username} ${e.event}: owner name`);
    if (data.isOwner !== (p.username === ownerName)) out.push(`${p.username} ${e.event}: isOwner ${String(data.isOwner)}`);
  }
  return out;
}

function setup(plantedBy?: string): void {
  room = roomManager.createRoom("alice", "sock-alice");
  roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
  roomManager.joinRoom(room.gameCode, "carol", "sock-carol");
  if (plantedBy) {
    room.players.find((p) => p.username === plantedBy)!.plantedPhoto = PLANTED;
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

describe("photo owner secrecy before the reveal (EXP-128)", () => {
  it("uploaded photo: every socket gets one round-start; only the owner's says isOwner", () => {
    setup();
    const owner = room.currentPlayer!;
    const since = emits.length;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    for (const p of room.players) {
      const starts = receivedBy(emits.slice(since), p.socketId, room.gameCode).filter((e) => e.event === "round-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].args[0]).toEqual({ photo: PHOTO, round: 1, duration: ANSWER_TIME - ANSWER_GRACE, isOwner: p === owner });
    }
    expect(room.players.flatMap((p) => leaksFor(p, owner.username, since))).toEqual([]);
  });

  it("planted photo: the planter is told it is theirs, nobody else learns who planted it", () => {
    setup("carol");
    const carol = room.players.find((p) => p.username === "carol")!;
    expect(room.currentPlayer).toBe(carol);
    expect(room.phase).toBe("answering");
    for (const p of room.players) {
      const starts = receivedBy(emits, p.socketId, room.gameCode).filter((e) => e.event === "round-start");
      expect(starts).toHaveLength(1);
      expect(starts[0].args[0]).toEqual({ photo: PLANTED, round: 1, duration: ANSWER_TIME - ANSWER_GRACE, isOwner: p === carol });
    }
    expect(room.players.flatMap((p) => leaksFor(p, "carol", 0))).toEqual([]);
  });

  it("game-state on rejoin: isOwner only in the owner's own snapshot, no owner name until reveal", () => {
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
      expect(snaps[0].args[0]).toMatchObject({ phase: "answering", photo: PHOTO, correctAnswer: null, isOwner: p === owner });
      expect(snaps[0].args[0]).not.toHaveProperty("owner");
    }
    expect(room.players.flatMap((p) => leaksFor(p, owner.username, since))).toEqual([]);

    // A non-owner and the owner rejoining on new sockets: same rule
    for (const p of [room.players.find((x) => x !== owner)!, owner]) {
      p.socketId = `${p.socketId}-2`;
      const before = emits.length;
      engine.onPlayerRejoined(room, p);
      const snap = receivedBy(emits.slice(before), p.socketId, room.gameCode).find((e) => e.event === "game-state")!;
      expect(snap.args[0]).toMatchObject({ phase: "answering", isOwner: p === owner, correctAnswer: null });
      expect(leaksFor(p, owner.username, before)).toEqual([]);
    }

    // From the reveal on, the answer is public (correctAnswer) and the owner still knows it is theirs
    const other = room.players.find((p) => p !== owner)!;
    vi.advanceTimersByTime(ANSWER_TIME);
    expect(room.phase).toBe("reveal");
    expect(engine.snapshot(room, other)).toMatchObject({ correctAnswer: owner.username, isOwner: false });
    expect(engine.snapshot(room, owner)).toMatchObject({ correctAnswer: owner.username, isOwner: true });
    vi.advanceTimersByTime(REVEAL_TIME);
    expect(engine.snapshot(room, owner)).toMatchObject({ phase: "scores", isOwner: true });
  });

  it("no player name appears in waiting-photo or round-start payloads", () => {
    setup();
    const owner = room.currentPlayer!;
    engine.onPhotoReceived(room, PHOTO, owner.username);
    const payloads = emits.filter((e) => e.event === "round-start" || e.event === "waiting-photo").map((e) => e.args);
    for (const n of NAMES) expect(strings(payloads)).not.toContain(n);
  });
});
