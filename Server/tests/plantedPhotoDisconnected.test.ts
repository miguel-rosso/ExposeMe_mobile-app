import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { PLANTED_DELAY_MAX } from "../managers/plantedDelay";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Player, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-145: a planted slot only draws planted photos of connected players (like the owners of uploaded photos). A
// disconnected planter keeps their photo: the slot is played as a normal round and the photo gets a later free
// round, where it is shown if they are back. Nothing tells the others that a round was (or would have been) planted.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const OTHER_PLANTED = "/temp/" + "c".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;
/** Photo of each round-start, once per round (round-start is sent to each player separately). */
const roundStartPhotos = () => [...new Set(events("round-start").map((e) => (e.args[0] as { photo: string }).photo))];

/** alice (host), bob, carol in a `rounds`-round game; `planters` planted a photo each in the lobby. */
function lobby(rounds: number, planters: Record<string, string>): Room {
  const r = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(r.gameCode, "bob", "sock-bob");
  rm.joinRoom(r.gameCode, "carol", "sock-carol");
  r.rounds = rounds;
  for (const [name, photo] of Object.entries(planters)) plantPhoto(r.gameCode, r.players.find((p) => p.username === name)!, photo);
  return r;
}

/** Everyone ready, round 1 forced as the only planted slot; the first round starts after GAME_START_DELAY. */
function readyWithPlantedRoundOne(): void {
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  room.plantedSlots = new Set([1]);
}

function drop(name: string): void {
  const p = player(name);
  rm.markDisconnected(room.gameCode, name, p.socketId);
  engine.onConnectionChange(room);
}

function rejoin(name: string): Player {
  const p = player(name);
  expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-2`, p.rejoinToken)).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, p);
  return p;
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
  uploadStore.clear();
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("planted photos of disconnected players are not drawn", () => {
  it("with the only planter disconnected, the planted slot is a normal round and the planter keeps the photo", () => {
    room = lobby(10, { bob: PLANTED });
    readyWithPlantedRoundOne();
    drop("bob");
    vi.advanceTimersByTime(GAME_START_DELAY);

    // A normal round: room-wide waiting-photo, your-turn to a connected player
    expect(room.currentPlayer).not.toBeNull();
    expect(room.currentPlayer!.username).not.toBe("bob");
    expect(events("waiting-photo")).toHaveLength(1);
    expect(events("your-turn").map((e) => e.target)).toEqual([room.currentPlayer!.socketId]);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(events("round-start")).toHaveLength(0);

    expect(player("bob").plantedPhoto).toBe(PLANTED);
    expect(player("bob").hasPlantedPhoto).toBe(true);
    // ...and a later round is reserved for it
    expect(room.plantedSlots.size).toBe(1);
    expect([...room.plantedSlots][0]).toBeGreaterThanOrEqual(2);
  });

  it("the kept photo is shown in a later round once the planter is back", () => {
    room = lobby(2, { bob: PLANTED });
    readyWithPlantedRoundOne();
    drop("bob");
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.plantedSlots).toEqual(new Set([2]));

    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    rejoin("bob");
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    // Round 2 is bob's planted round: no your-turn, his photo after the hidden delay
    expect(events("your-turn")).toHaveLength(1);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(roundStartPhotos()).toEqual([PHOTO, PLANTED]);
    expect(player("bob").plantedPhoto).toBeUndefined();
  });

  it("a connected planter's photo is drawn, never a disconnected one's", () => {
    room = lobby(10, { bob: PLANTED, carol: OTHER_PLANTED });
    readyWithPlantedRoundOne();
    drop("bob");
    vi.spyOn(Math, "random").mockReturnValue(0); // would pick bob, the first planter in the room
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(events("your-turn")).toHaveLength(0);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);

    expect(roundStartPhotos()).toEqual([OTHER_PLANTED]);
    expect(room.currentPlayer).toBe(player("carol"));
    expect(player("bob").plantedPhoto).toBe(PLANTED);
  });

  it("with no free round left the slot is still a normal round, and nothing extra is reserved", () => {
    room = lobby(1, { bob: PLANTED });
    readyWithPlantedRoundOne();
    drop("bob");
    vi.advanceTimersByTime(GAME_START_DELAY);

    expect(room.currentPlayer?.username).not.toBe("bob");
    expect(events("your-turn")).toHaveLength(1);
    expect(room.plantedSlots.size).toBe(0);
    expect(player("bob").plantedPhoto).toBe(PLANTED);
  });
});
