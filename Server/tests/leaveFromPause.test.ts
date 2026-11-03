import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, PAUSE_TIMEOUT } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-377 / DEC-050 A: the app's pause modal has an Exit (leave-room). The player left waiting in a pause (the only one
// connected) leaves for good while the one it waits for is only disconnected. That leave is a real leave (DEC-011):
// the room keeps waiting for the disconnected player, whose return then ends the game at once (it is alone), instead
// of pausing again for the one who left; if it never returns, the countdown ends the game as usual.

const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg"; // shape of a POST /upload result

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  rm = new RoomManager();
  engine = new GameEngine(fake.io, rm);
  // alice and bob answering round 1; bob's connection drops: the game pauses for him
  room = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(room.gameCode, "bob", "sock-bob");
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
  rm.markDisconnected(room.gameCode, "bob", "sock-bob");
  engine.onConnectionChange(room);
  expect(room.paused).toBe(true);
  // alice, waiting in the pause, leaves (the pause modal's Exit)
  engine.removePlayer(room, "alice", "left");
});

afterEach(() => {
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rejoinBob(): Player {
  const bob = player("bob");
  expect(rm.joinRoom(room.gameCode, "bob", "sock-bob-2", bob.rejoinToken)).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, bob);
  return bob;
}

describe("leaving from the pause (EXP-377)", () => {
  it("the one who left is gone for good: not in the room nor awaited, and no new pause starts for her", () => {
    expect(room.players.map((p) => p.username)).toEqual(["bob"]);
    expect(events("game-paused")).toHaveLength(1);
    expect(events("game-over")).toHaveLength(0); // bob may still come back
  });

  it("the disconnected player's return ends the game at once: nobody is left to play with", () => {
    rejoinBob();
    expect(events("game-over")).toHaveLength(1);
    expect(events("game-resumed")).toHaveLength(0);
    expect(events("game-paused")).toHaveLength(1);
    expect(room.started).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("if nobody returns, the pause countdown ends the game as usual", () => {
    vi.advanceTimersByTime(PAUSE_TIMEOUT);
    expect(events("game-over")).toHaveLength(1);
    expect(room.started).toBe(false);
  });
});
