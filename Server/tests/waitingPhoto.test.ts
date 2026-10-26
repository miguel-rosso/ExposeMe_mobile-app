import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-039 / EXP-040: while the server waits for the chosen player's photo the whole room gets
// `waiting-photo { round, duration }` (owner kept secret), skips say why (`round-skipped { round, reason }`),
// and the owner can report `photo-unavailable` to skip at once instead of making everyone wait 15 s.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const MAX_CONSECUTIVE_SKIPS = 3;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const last = (name: string) => events(name)[events(name).length - 1];
const owner = () => room.currentPlayer!;
/** The photo request in force (last your-turn sent) */
const turn = () => last("your-turn")!.args[0] as { round: number; attempt: number };
/** photo-unavailable from `name`, echoing the current your-turn unless another one is given */
const report = (name: string, t: { round: number; attempt: number } = turn()) => engine.onPhotoUnavailable(room, name, t.round, t.attempt);

function setupStartedRoom(names = ["alice", "bob", "carol"]): Room {
  const r = roomManager.createRoom(names[0], `sock-${names[0]}`);
  names.slice(1).forEach((n) => roomManager.joinRoom(r.gameCode, n, `sock-${n}`));
  roomManager.setRounds(r.gameCode, 10);
  engine.startGame(r);
  r.players.forEach((p) => (p.isReady = true));
  engine.onAllPlayersReady(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  roomManager = new RoomManager();
  engine = new GameEngine(fake.io, roomManager);
  room = setupStartedRoom();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waiting-photo broadcast (EXP-039)", () => {
  it("tells the whole room a photo is awaited, with the round and the server's wait time, before your-turn", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    const ev = last("waiting-photo")!;
    expect(ev).toEqual({ target: room.gameCode, event: "waiting-photo", args: [{ round: 1, duration: PHOTO_WAIT_TIMEOUT }] });
    // Room-wide and before the owner's own your-turn
    const idxWaiting = emits.indexOf(ev);
    const idxTurn = emits.indexOf(last("your-turn")!);
    expect(idxWaiting).toBeLessThan(idxTurn);
  });

  it("never reveals the owner: one room-wide emit, no username in the payload", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("waiting-photo")).toHaveLength(1);
    expect(JSON.stringify(last("waiting-photo")!.args)).not.toContain(owner().username);
    expect(room.players.some((p) => last("waiting-photo")!.target === p.socketId)).toBe(false);
  });

  it("is sent again for the next round after scores, with the next round number", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    engine.onPhotoReceived(room, PHOTO, owner().username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(events("waiting-photo")).toHaveLength(2);
    expect(last("waiting-photo")!.args[0]).toEqual({ round: 2, duration: PHOTO_WAIT_TIMEOUT });
  });

  it("a timed-out round is announced with its number and reason, then the round is awaited again", () => {
    vi.advanceTimersByTime(GAME_START_DELAY + PHOTO_WAIT_TIMEOUT);
    expect(last("round-skipped")!).toEqual({ target: room.gameCode, event: "round-skipped", args: [{ round: 1, reason: "timeout" }] });
    expect(events("waiting-photo")).toHaveLength(2);
    expect(last("waiting-photo")!.args[0]).toEqual({ round: 1, duration: PHOTO_WAIT_TIMEOUT });
  });

  it("the game-state snapshot carries the waiting-photo phase with the remaining wait and no owner", () => {
    vi.advanceTimersByTime(GAME_START_DELAY + 4_000);
    const snap = engine.snapshot(room);
    expect(snap).toMatchObject({ phase: "waiting-photo", round: 0, photo: null, duration: PHOTO_WAIT_TIMEOUT - 4_000 });
  });
});

describe("photo-unavailable (EXP-040)", () => {
  it("skips the round at once when the chosen player reports it, without waiting 15 s", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    const first = owner();
    report(first.username);
    expect(last("round-skipped")!.args[0]).toEqual({ round: 1, reason: "unavailable" });
    expect(room.phase).toBe("waiting-photo");
    expect(room.round).toBe(0);
    expect(events("waiting-photo")).toHaveLength(2);
    // The next owner is someone else (they just said they have no photo)
    expect(owner()).not.toBe(first);
    expect(last("your-turn")!.target).toBe(owner().socketId);
    expect(room._consecutiveSkips).toBe(1);
  });

  it("is ignored from anyone but the chosen player, outside waiting-photo and while paused", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    const other = room.players.find((p) => p !== owner())!;
    report(other.username);
    expect(events("round-skipped")).toHaveLength(0);

    engine.onPhotoReceived(room, PHOTO, owner().username);
    report(owner().username);
    expect(events("round-skipped")).toHaveLength(0);
    expect(room.phase).toBe("answering");

    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    room.paused = true;
    report(owner().username);
    expect(events("round-skipped")).toHaveLength(0);
  });

  it("a duplicate report only skips once (the next round's owner is another player)", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    const first = owner().username;
    const t = turn();
    report(first, t);
    report(first, t);
    report(first, t);
    expect(events("round-skipped")).toHaveLength(1);
    expect(events("your-turn")).toHaveLength(2);
  });

  it("your-turn carries a new attempt id per photo request, also when the round number repeats", () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(turn()).toEqual({ round: 1, attempt: 1 });
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(turn()).toEqual({ round: 1, attempt: 2 });
  });

  it("a stale report (earlier attempt of the same round, same player re-picked) or a mismatched one is ignored", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // always the first connected player
    vi.advanceTimersByTime(GAME_START_DELAY);
    const first = owner().username;
    const stale = turn();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT); // timeout skip: the same player is asked again
    expect(owner().username).toBe(first);
    expect(turn()).toEqual({ round: 1, attempt: stale.attempt + 1 });

    report(first, stale);
    report(first, { round: 2, attempt: turn().attempt });
    report(first, { round: 1, attempt: turn().attempt + 1 });
    expect(events("round-skipped")).toHaveLength(1); // only the timeout

    report(first); // the current request
    expect(events("round-skipped")).toHaveLength(2);
    expect(last("round-skipped")!.args[0]).toEqual({ round: 1, reason: "unavailable" });
  });

  it("the old wait timer is gone: the new owner gets the full 15 s", () => {
    vi.advanceTimersByTime(GAME_START_DELAY + 10_000);
    report(owner().username);
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1);
    expect(events("round-skipped")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events("round-skipped")).toHaveLength(2);
    expect(last("round-skipped")!.args[0]).toEqual({ round: 1, reason: "timeout" });
  });

  it(`counts toward the ${MAX_CONSECUTIVE_SKIPS} consecutive skips that end the game`, () => {
    vi.advanceTimersByTime(GAME_START_DELAY);
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS; i++) report(owner().username);
    expect(events("round-skipped")).toHaveLength(MAX_CONSECUTIVE_SKIPS);
    expect(events("game-over")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("with 2 players the other one is picked next", () => {
    vi.clearAllTimers();
    emits.length = 0;
    room = setupStartedRoom(["ana", "ben"]);
    vi.advanceTimersByTime(GAME_START_DELAY);
    const first = owner().username;
    report(first);
    expect(owner().username).not.toBe(first);
  });
});
