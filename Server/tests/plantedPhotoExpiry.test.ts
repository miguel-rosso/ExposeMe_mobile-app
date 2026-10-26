import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, plantPhoto } from "./helpers";

// EXP-117: a planted photo whose upload expired (UPLOAD_TTL_MS after it was stored) or will expire before its round
// is over is never drawn: its planter's planted photo is dropped and the round is played with a normal photo.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const PLANTED_DELAY_MAX = 3_000;
const PLANTED_PHOTO_MIN_LIFETIME = PHOTO_WAIT_TIMEOUT + ANSWER_TIME + REVEAL_TIME;
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";
const OTHER_PLANTED = "/temp/" + "d".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;
const roundStartPhotos = () => events("round-start").map((e) => (e.args[0] as { photo: string }).photo);

function lobby(): Room {
  const r = rm.createRoom("alice", "sock-alice");
  rm.joinRoom(r.gameCode, "bob", "sock-bob");
  rm.joinRoom(r.gameCode, "carol", "sock-carol");
  return r;
}

/** Starts the game with round 1 as the planted slot and runs to its first photo wait. */
function startWithPlantedRoundOne(): void {
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  room.plantedSlots = new Set([1]);
  vi.advanceTimersByTime(GAME_START_DELAY);
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("expired planted photos are not drawn", () => {
  it("a planted photo past its TTL is dropped and the round asks a player for a normal photo", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    vi.advanceTimersByTime(UPLOAD_TTL_MS); // the room stayed in the lobby for 30 min
    startWithPlantedRoundOne();

    expect(player("bob").plantedPhoto).toBeUndefined();
    expect(player("bob").hasPlantedPhoto).toBe(false);
    expect(room.currentPlayer).not.toBeNull();
    expect(events("your-turn")).toHaveLength(1);
    expect(events("waiting-photo")).toHaveLength(1);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(roundStartPhotos()).not.toContain(PLANTED);
    expect(room.plantedPhotosShown).toBe(0);
  });

  it("a planted photo that would expire before its round is over is dropped too", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    vi.advanceTimersByTime(UPLOAD_TTL_MS - PLANTED_PHOTO_MIN_LIFETIME + GAME_START_DELAY);
    startWithPlantedRoundOne();

    expect(player("bob").plantedPhoto).toBeUndefined();
    expect(events("your-turn")).toHaveLength(1);
  });

  it("a planted photo whose upload was already deleted (no longer stored) is dropped", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    uploadStore.forget(PLANTED.slice("/temp/".length)); // what the exact TTL timer of /upload does
    startWithPlantedRoundOne();

    expect(player("bob").plantedPhoto).toBeUndefined();
    expect(events("your-turn")).toHaveLength(1);
  });

  it("a planted photo that outlives its round is still played", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    vi.advanceTimersByTime(UPLOAD_TTL_MS - PLANTED_PHOTO_MIN_LIFETIME - GAME_START_DELAY - 1);
    startWithPlantedRoundOne();

    expect(events("your-turn")).toHaveLength(0);
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(roundStartPhotos()).toEqual([PLANTED, PLANTED]); // room-wide + the planter's own
    expect(room.currentPlayer).toBe(player("bob"));
    expect(room.plantedPhotosShown).toBe(1);
  });

  it("a dropped planted photo that is still stored is deleted right away", async () => {
    room = lobby();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-exp117-"));
    try {
      const name = PLANTED.slice("/temp/".length);
      const file = path.join(dir, name);
      fs.writeFileSync(file, "x");
      uploadStore.register(name, { gameCode: room.gameCode, username: "bob", file }, uploadStore.epoch(room.gameCode));
      player("bob").plantedPhoto = PLANTED;
      vi.advanceTimersByTime(UPLOAD_TTL_MS - PLANTED_PHOTO_MIN_LIFETIME); // not expired yet, but too close
      startWithPlantedRoundOne();

      expect(player("bob").plantedPhoto).toBeUndefined();
      expect(uploadStore.get(name)).toBeUndefined();
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a planted photo that expires while its wait is paused is not shown: the round times out like a normal one", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    // Drawn with just over PLANTED_PHOTO_MIN_LIFETIME left
    vi.advanceTimersByTime(UPLOAD_TTL_MS - PLANTED_PHOTO_MIN_LIFETIME - GAME_START_DELAY - 1);
    startWithPlantedRoundOne();
    expect(events("your-turn")).toHaveLength(0);

    // Paused in the planted delay for 2 min: the photo expires meanwhile
    for (const name of ["alice", "carol"]) {
      rm.markDisconnected(room.gameCode, name, player(name).socketId);
      engine.onConnectionChange(room);
    }
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(2 * 60_000);
    for (const name of ["alice", "carol"]) {
      const p = player(name);
      expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-2`, p.rejoinToken)).toMatchObject({ success: true, rejoin: true });
      engine.onPlayerRejoined(room, p);
    }
    expect(room.paused).toBe(false);

    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(roundStartPhotos()).not.toContain(PLANTED);
    expect(events("round-skipped").map((e) => e.args[0])).toEqual([{ round: 1, reason: "timeout" }]);
    expect(uploadStore.get(PLANTED.slice("/temp/".length))).toBeUndefined();
    expect(room.plantedPhotosShown).toBe(0);
  });

  it("with an expired and a live planted photo, the live one is drawn", () => {
    room = lobby();
    plantPhoto(room.gameCode, player("bob"), PLANTED);
    vi.advanceTimersByTime(UPLOAD_TTL_MS);
    plantPhoto(room.gameCode, player("carol"), OTHER_PLANTED);
    startWithPlantedRoundOne();

    expect(player("bob").plantedPhoto).toBeUndefined();
    vi.advanceTimersByTime(PLANTED_DELAY_MAX);
    expect(roundStartPhotos()).toEqual([OTHER_PLANTED, OTHER_PLANTED]);
    expect(room.currentPlayer).toBe(player("carol"));
  });
});
