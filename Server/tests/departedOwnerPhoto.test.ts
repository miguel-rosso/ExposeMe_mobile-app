import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Player, Room } from "../models/interfaces";
import { createFakeIo, plantPhoto, registerTurnUpload } from "./helpers";

// EXP-116: the photo on screen stays when its owner leaves mid-round (nobody's round changes), but once that round
// is over the server drops it, reference and stored upload alike, instead of keeping it until game over. A photo
// whose owner is still in the room keeps the usual lifetime (deleted with the rest at game over).

const GAME_START_DELAY = 1_000;
const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const PLANTED_DELAY = 2_000; // with Math.random() = 0 and no past waits in the room
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const PLANTED = "/temp/" + "b".repeat(32) + ".jpg";

let engine: GameEngine;
let rm: RoomManager;
let room: Room;

const player = (name: string) => room.players.find((p) => p.username === name)!;
const stored = (photo: string) => uploadStore.get(photo.slice("/temp/".length)) !== undefined;

/** alice, bob, carol, dan in a 3-round game; bob's planted photo is round 1 when `planted`. Returns at round 1's wait. */
function startGame(planted: boolean): void {
  room = rm.createRoom("alice", "sock-alice");
  for (const name of ["bob", "carol", "dan"]) rm.joinRoom(room.gameCode, name, `sock-${name}`);
  room.rounds = 3;
  if (planted) plantPhoto(room.gameCode, player("bob"), PLANTED);
  engine.startGame(room);
  room.players.forEach((p) => engine.markReady(room, p));
  room.plantedSlots = new Set(planted ? [1] : []);
  vi.advanceTimersByTime(GAME_START_DELAY);
}

/** Round 1 goes to answering with the owner's photo (uploaded, or bob's planted one); returns the owner. */
function playRoundPhoto(planted: boolean): { owner: Player; photo: string } {
  if (planted) {
    vi.advanceTimersByTime(PLANTED_DELAY);
    return { owner: player("bob"), photo: PLANTED };
  }
  const owner = room.currentPlayer!;
  registerTurnUpload(room.gameCode, owner.username, PHOTO, 1);
  engine.onPhotoReceived(room, PHOTO, owner.username);
  return { owner, photo: PHOTO };
}

/** leave-room as socketRoutes handles it. */
function leave(name: string): void {
  rm.removePlayer(room.gameCode, name);
  engine.onConnectionChange(room);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {}); // the test uploads have no file to unlink
  vi.spyOn(Math, "random").mockReturnValue(0);
  rm = new RoomManager();
  engine = new GameEngine(createFakeIo().io, rm);
});

afterEach(() => {
  rm.clear();
  uploadStore.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the on-screen photo of an owner who left (EXP-116)", () => {
  for (const planted of [false, true]) {
    const kind = planted ? "planted" : "uploaded";

    it(`${kind}: kept for the rest of its round, dropped once the round is over`, () => {
      startGame(planted);
      const { owner, photo } = playRoundPhoto(planted);
      expect(room.phase).toBe("answering");

      leave(owner.username);
      // The round in play is unchanged for everyone: same photo through answering, reveal and scores
      expect(stored(photo)).toBe(true);
      vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME);
      expect(room.phase).toBe("scores");
      expect(engine.snapshot(room).photo).toBe(photo);
      expect(stored(photo)).toBe(true);

      vi.advanceTimersByTime(SCORE_DISPLAY_TIME);
      expect(room).toMatchObject({ started: true, phase: "waiting-photo", round: 1, currentPhoto: null });
      expect(engine.snapshot(room).photo).toBeNull();
      expect(stored(photo)).toBe(false);
    });
  }

  it("an owner still in the room keeps their played photo until game over", () => {
    startGame(false);
    const { photo } = playRoundPhoto(false);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(room).toMatchObject({ phase: "waiting-photo", currentPhoto: null });
    expect(stored(photo)).toBe(true);
  });

  it("another player leaving doesn't drop the photo on screen", () => {
    startGame(false);
    const { owner, photo } = playRoundPhoto(false);
    leave(room.players.find((p) => p !== owner)!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
    expect(stored(photo)).toBe(true);
  });

  it("never deletes an upload of another room, whatever the room points at", () => {
    startGame(false);
    const other = rm.createRoom("zed", "sock-zed");
    registerTurnUpload(other.gameCode, "zed", PHOTO, 1); // zed is not in `room`
    room.currentPhoto = PHOTO;
    rm.clearShownPhoto(room);
    expect(room.currentPhoto).toBeNull();
    expect(stored(PHOTO)).toBe(true);
  });
});
