import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room, YourTurnData } from "../models/interfaces";
import { CapturedEmit, createFakeIo, receivedBy } from "./helpers";

// EXP-110: a skipped round doesn't tell the room why. The room gets the same `round-skipped { round }` whatever the
// cause; only the awaited owner gets the reason, in their own copy.

const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

/** round-skipped payloads `player` received, in order */
const skipsSeenBy = (player: Player) =>
  receivedBy(emits, player.socketId, room.gameCode).filter((e) => e.event === "round-skipped").map((e) => e.args[0]);
const turn = () => emits.filter((e) => e.event === "your-turn").pop()!.args[0] as YourTurnData;

function startedRoom(names: string[]): Room {
  const r = roomManager.createRoom(names[0], `sock-${names[0]}`);
  names.slice(1).forEach((n) => roomManager.joinRoom(r.gameCode, n, `sock-${n}`));
  roomManager.setRounds(r.gameCode, 10);
  engine.startGame(r);
  r.players.forEach((p) => (p.isReady = true));
  engine.onAllPlayersReady(r);
  vi.advanceTimersByTime(GAME_START_DELAY);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  roomManager = new RoomManager();
  engine = new GameEngine(fake.io, roomManager);
  room = startedRoom(["alice", "bob", "carol"]);
});

afterEach(() => {
  roomManager.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("round-skipped reason privacy (EXP-110)", () => {
  it("the others get the same payload for a photo-unavailable skip as for a timeout one", () => {
    const unavailableOwner = room.currentPlayer!;
    const watchersOfUnavailable = room.players.filter((p) => p !== unavailableOwner);
    engine.onPhotoUnavailable(room, unavailableOwner.username, turn().round, turn().attempt);

    const timeoutOwner = room.currentPlayer!;
    const watchersOfTimeout = room.players.filter((p) => p !== timeoutOwner);
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);

    const roomCopies = (watchers: Player[], skip: number) => watchers.map((p) => skipsSeenBy(p)[skip]);
    expect(roomCopies(watchersOfUnavailable, 0)).toEqual(watchersOfUnavailable.map(() => ({ round: 1 })));
    expect(roomCopies(watchersOfTimeout, 1)).toEqual(watchersOfTimeout.map(() => ({ round: 1 })));
  });

  it("the owner who reported photo-unavailable gets the reason in their own copy, and only one copy", () => {
    const owner = room.currentPlayer!;
    engine.onPhotoUnavailable(room, owner.username, turn().round, turn().attempt);
    expect(skipsSeenBy(owner)).toEqual([{ round: 1, reason: "unavailable" }]);
  });

  it("the owner whose photo never arrived gets reason timeout, the others no reason", () => {
    const owner = room.currentPlayer!;
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(skipsSeenBy(owner)).toEqual([{ round: 1, reason: "timeout" }]);
    for (const p of room.players.filter((x) => x !== owner)) expect(skipsSeenBy(p)).toEqual([{ round: 1 }]);
  });

  it("no emitted round-skipped carries a reason except the one addressed to the owner's socket", () => {
    const owner = room.currentPlayer!;
    engine.onPhotoUnavailable(room, owner.username, turn().round, turn().attempt);
    const withReason = emits.filter((e) => e.event === "round-skipped" && "reason" in (e.args[0] as object));
    expect(withReason.map((e) => e.target)).toEqual([owner.socketId]);
  });
});
