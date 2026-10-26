import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { GameStateSnapshot, Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo } from "./helpers";

// EXP-184 (DEC-018 A): a player still on the final screens when the host starts the next game is taken into it by the
// app: its lobby re-sends join-create-game on the same socket (resendState), gets a snapshot of the started game in the
// ready phase, and its fresh game screen sends im-ready. The server contract this relies on: after a game over, the
// next game's ready phase waits for that player's im-ready (isReady was reset), and once it arrives the first round
// starts right away (GAME_START_DELAY), not after READY_TIMEOUT.

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const READY_TIMEOUT = 10_000;
const PHOTO = "https://example.invalid/photo.jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let roomManager: RoomManager;
let room: Room;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fake = createFakeIo();
  emits = fake.emits;
  roomManager = new RoomManager();
  engine = new GameEngine(fake.io, roomManager);
  room = roomManager.createRoom("alice", "sock-alice");
  roomManager.joinRoom(room.gameCode, "bob", "sock-bob");
  roomManager.joinRoom(room.gameCode, "carol", "sock-carol");
  roomManager.setRounds(room.gameCode, 10);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** First game, played to game-over with every player ready. */
function playFirstGame(): void {
  expect(engine.startGame(room)).toBe(true);
  room.players.forEach((p) => engine.markReady(room, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  for (let i = 0; i < 10; i++) {
    engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
    vi.advanceTimersByTime(ANSWER_TIME + REVEAL_TIME + SCORE_DISPLAY_TIME);
  }
  expect(events("game-over")).toHaveLength(1);
}

describe("a player lingering on the final screens joins the next game (EXP-184)", () => {
  it("the next game waits for its im-ready and starts as soon as it arrives, not at the ready timeout", () => {
    playFirstGame();
    // alice and bob played again; carol is still on the final screens (connected, same socket)
    expect(engine.startGame(room)).toBe(true);
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    vi.advanceTimersByTime(2_000);
    expect(room.phase).toBeNull(); // still waiting for carol, who is connected

    // The app's lobby re-sends its join on the same socket: a snapshot of the started game in the ready phase
    emits.length = 0;
    engine.resendState(room, player("carol"));
    const snap = events("game-state").find((e) => e.target === "sock-carol")!.args[0] as GameStateSnapshot;
    expect(snap).toMatchObject({ started: true, phase: null, round: 0, totalRounds: 10 });
    expect(events("your-turn")).toHaveLength(0);

    // Its fresh game screen sends im-ready: the first round follows after GAME_START_DELAY
    engine.markReady(room, player("carol"));
    vi.advanceTimersByTime(GAME_START_DELAY);
    const waiting = events("waiting-photo");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].args[0]).toMatchObject({ round: 1 });
    // 3 s after start-game: the ready timeout never had to decide (it fires no second round start either)
    vi.advanceTimersByTime(READY_TIMEOUT);
    expect(events("waiting-photo").length + events("round-start").length).toBeGreaterThanOrEqual(1);
    expect(events("game-over")).toHaveLength(0);
  });

  it("without that im-ready the ready timeout is what starts the game (the wait the auto-join avoids)", () => {
    playFirstGame();
    expect(engine.startGame(room)).toBe(true);
    engine.markReady(room, player("alice"));
    engine.markReady(room, player("bob"));
    emits.length = 0;
    vi.advanceTimersByTime(READY_TIMEOUT - 1);
    expect(room.phase).toBeNull();
    vi.advanceTimersByTime(1 + GAME_START_DELAY);
    expect(events("waiting-photo")).toHaveLength(1);
  });
});
