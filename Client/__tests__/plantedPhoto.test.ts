import { acceptsPlantedPhoto, gameWentBySince, ReplantCheck, shouldReplantAfterRejoin } from "../src/utils/plantedPhoto";

// EXP-277: after an in-game rejoin, a planted photo the server lost is planted again while the server still takes it

const READY = { phase: null, round: 0, started: true } as const; // ready phase: nothing drawn yet
const ROUND_1_WAIT = { phase: "waiting-photo", round: 0, started: true } as const;
const AFTER_GAME_OVER = { phase: null, round: 0, started: false } as const; // marks cleared by game over

const check = (over: Partial<ReplantCheck>): boolean => shouldReplantAfterRejoin({
  room: READY, hasPlantedPhoto: false, plantedPhotoUri: "file:///picked.jpg", plantedPhotoSent: false, ...over,
});

describe("acceptsPlantedPhoto (same rule as the server)", () => {
  it("takes planted photos until round 1 is played", () => {
    expect(acceptsPlantedPhoto(READY)).toBe(true);
    expect(acceptsPlantedPhoto(ROUND_1_WAIT)).toBe(true);
    expect(acceptsPlantedPhoto({ phase: "answering", round: 0 })).toBe(false);
    expect(acceptsPlantedPhoto({ phase: "waiting-photo", round: 1 })).toBe(false);
    expect(acceptsPlantedPhoto({ phase: undefined, round: undefined })).toBe(false); // unknown: don't plant
  });
});

describe("shouldReplantAfterRejoin", () => {
  it("plants again a photo the server lacks, even one this device thinks it sent, before anything is drawn", () => {
    expect(check({})).toBe(true);
    // Sent on the new socket before the rejoin bound it to the room: the server dropped it
    expect(check({ plantedPhotoSent: true })).toBe(true);
  });

  it("not when the server has it, nothing was picked, or round 1 has been played", () => {
    expect(check({ hasPlantedPhoto: true })).toBe(false);
    expect(check({ plantedPhotoUri: null })).toBe(false);
    expect(check({ room: { phase: "answering", round: 0, started: true } })).toBe(false);
    expect(check({ room: { phase: "scores", round: 1, started: true } })).toBe(false);
  });

  // Review of EXP-277: game over also leaves no phase, and clears every mark; this game's photo is not the next one's
  it("not after game over (no started game), sent or not", () => {
    expect(check({ room: AFTER_GAME_OVER })).toBe(false);
    expect(check({ room: AFTER_GAME_OVER, plantedPhotoSent: true })).toBe(false);
    expect(check({ room: { phase: null, round: 0, started: undefined } })).toBe(false);
  });

  it("during round 1's wait, only a photo never sent: a sent one may be the one being played", () => {
    expect(check({ room: ROUND_1_WAIT })).toBe(true);
    expect(check({ room: ROUND_1_WAIT, plantedPhotoSent: true })).toBe(false);
  });
});

// EXP-399: a lobby rejoin tells by the room's game number whether a game was played while it was away
describe("gameWentBySince", () => {
  it("only when the room's number is higher than the last one this lobby saw", () => {
    expect(gameWentBySince(2, 3)).toBe(true);
    expect(gameWentBySince(0, 1)).toBe(true);
    expect(gameWentBySince(2, 2)).toBe(false);
  });

  it("not when either number is unknown (first answer of this lobby, or a server that sends none)", () => {
    expect(gameWentBySince(null, 3)).toBe(false);
    expect(gameWentBySince(2, undefined)).toBe(false);
  });
});
