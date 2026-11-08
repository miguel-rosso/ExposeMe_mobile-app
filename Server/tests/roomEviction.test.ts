import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, PAUSE_TIMEOUT } from "../managers/GameEngine";
import { EVICTABLE_AFTER_DISCONNECT, MAX_ROOMS, RoomManager, RoomQuota } from "../managers/RoomManager";
import { Room } from "../models/interfaces";
import { createFakeIo } from "./helpers";

// EXP-450 / EXP-451: rooms whose players all left without leaving (disconnected) are kept for them for a while, which
// let rooms be parked for free until MAX_ROOMS. Once the server is full, a room with no game in progress whose players
// have all been away for EVICTABLE_AFTER_DISCONNECT makes way for a new room. Below MAX_ROOMS nothing changes.

const QUOTA: RoomQuota = { key: "203.0.113.7", max: 20 };
// Ready timeout, then the pause of a game with nobody connected runs out: the game is over well within this
const GAME_ABANDONED_UNTIL_OVER = 10_000 + 15_000 + PAUSE_TIMEOUT + 60_000;

let rm: RoomManager;
let engine: GameEngine;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  rm = new RoomManager();
  engine = new GameEngine(createFakeIo().io, rm);
});

afterEach(() => {
  rm.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** alice (host) + bob in a lobby. */
function lobby(quotas: RoomQuota[] = []): Room {
  const room = rm.createRoom("alice", "sock-alice", quotas);
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  return room;
}

/** A lobby back from a finished game (play again not pressed yet). */
function finishedGame(): Room {
  const room = lobby();
  room.gameNumber = 1;
  return room;
}

function disconnectAll(room: Room): void {
  for (const p of [...room.players]) rm.markDisconnected(room.gameCode, p.username, p.socketId);
}

/** Fills the server up to MAX_ROOMS with rooms whose creator stays connected. */
function fillToCapacity(): void {
  let i = 0;
  while (rm.stats().rooms < MAX_ROOMS) rm.createRoom(`filler${i}`, `sock-filler${i++}`);
}

/** Creates one more room on a full server; the codes of the rooms it made way for are no longer found. */
function createOnFullServer(): Room {
  expect(rm.isAtCapacity()).toBe(false);
  const created = rm.createRoom("carol", "sock-carol");
  expect(rm.stats().rooms).toBe(MAX_ROOMS);
  return created;
}

describe("at MAX_ROOMS, an abandoned room makes way for a new one", () => {
  it("a lobby whose players have all been away for a minute is deleted, freeing its creator's quota", () => {
    const room = lobby([QUOTA]);
    disconnectAll(room);
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);

    const created = createOnFullServer();
    expect(rm.getRoom(created.gameCode)).toBe(created);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(rm.roomsCreatedBy(QUOTA.key)).toBe(0);
  });

  it("a finished game whose players have all been away is deleted too (no parking via start-game)", () => {
    const room = finishedGame();
    disconnectAll(room);
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);

    createOnFullServer();
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("never-played lobbies go first, then the oldest room", () => {
    const played = finishedGame();
    const olderLobby = lobby();
    const newerLobby = lobby();
    [played, olderLobby, newerLobby].forEach(disconnectAll);
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);

    createOnFullServer();
    expect(rm.getRoom(olderLobby.gameCode)).toBeUndefined();
    expect(rm.getRoom(newerLobby.gameCode)).toBe(newerLobby);
    expect(rm.getRoom(played.gameCode)).toBe(played);
    createOnFullServer();
    expect(rm.getRoom(newerLobby.gameCode)).toBeUndefined();
    expect(rm.getRoom(played.gameCode)).toBe(played);
    createOnFullServer();
    expect(rm.getRoom(played.gameCode)).toBeUndefined();
  });

  it("a game in progress is never deleted; once it ends by itself (pause expired) it can be", () => {
    const room = lobby();
    engine.startGame(room);
    disconnectAll(room);
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);
    expect(room.started).toBe(true);
    expect(rm.isAtCapacity()).toBe(true);

    vi.advanceTimersByTime(GAME_ABANDONED_UNTIL_OVER);
    expect(room.started).toBe(false);
    createOnFullServer();
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("a room whose players left only moments ago (sharing the code, app switch) is kept", () => {
    const room = lobby();
    disconnectAll(room);
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT - 1);
    expect(rm.isAtCapacity()).toBe(true);
    expect(EVICTABLE_AFTER_DISCONNECT).toBe(60_000);
  });

  it("a room with someone connected is kept", () => {
    const room = lobby();
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    fillToCapacity();
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);
    expect(rm.isAtCapacity()).toBe(true);
  });
});

describe("below MAX_ROOMS nothing is deleted early", () => {
  it("creating a room leaves abandoned rooms alone", () => {
    const room = lobby();
    disconnectAll(room);
    vi.advanceTimersByTime(EVICTABLE_AFTER_DISCONNECT);
    rm.createRoom("carol", "sock-carol");
    expect(rm.getRoom(room.gameCode)).toBe(room);
  });
});
