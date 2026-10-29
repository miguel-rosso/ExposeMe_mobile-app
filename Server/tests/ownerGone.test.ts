import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine, MAX_FREE_OWNER_CHANGES, OWNER_RETURN_WINDOW, PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { RoomManager } from "../managers/RoomManager";
import { Player, Room, WaitingPhotoData, YourTurnData } from "../models/interfaces";
import { CapturedEmit, createFakeIo, receivedBy } from "./helpers";

// EXP-029 / DEC-035: when the player picked to send the photo goes away (leaves the room, or stays disconnected for
// OWNER_RETURN_WINDOW: a brief flap goes unnoticed), the others don't sit through the rest of the 15 s wait and the
// round isn't lost: another connected player is picked for the same round (each player at most once per round). Each
// player has MAX_FREE_OWNER_CHANGES such changes per game that don't count toward MAX_CONSECUTIVE_SKIPS; beyond them
// they get no return window and leaving counts as a skip, so players can't steer every round onto someone. With
// nobody left to pick, the round is played again from scratch (same number), counted like any skip.

const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const MAX_CONSECUTIVE_SKIPS = 3;
const ROUND_TIME = ANSWER_TIME + 3_000 + 5_000; // answering, reveal, scores
const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";

let emits: CapturedEmit[];
let engine: GameEngine;
let rm: RoomManager;
let room: Room;
let rejoins = 0;

const events = (name: string) => emits.filter((e) => e.event === name);
const player = (name: string) => room.players.find((p) => p.username === name)!;
const waits = () => events("waiting-photo").map((e) => e.args[0] as WaitingPhotoData);
const lastTurn = () => events("your-turn").pop()!;

function startedRoom(names: string[]): Room {
  const r = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(r.gameCode, n, `sock-${n}`);
  engine.startGame(r);
  r.players.forEach((p) => engine.markReady(r, p));
  vi.advanceTimersByTime(GAME_START_DELAY);
  expect(r.phase).toBe("waiting-photo");
  return r;
}

/** Socket disconnect as socketRoutes handles it. */
function drop(name: string): void {
  rm.markDisconnected(room.gameCode, name, player(name).socketId);
  engine.onConnectionChange(room);
}

/** Rejoin on a new socket as socketRoutes handles it. */
function rejoin(name: string): Player {
  const p = player(name);
  expect(rm.joinRoom(room.gameCode, name, `${p.socketId}-${++rejoins}`, p.rejoinToken)).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, p);
  return p;
}

/** leave-room as socketRoutes handles it. */
function leave(name: string): void {
  rm.removePlayer(room.gameCode, name);
  engine.onConnectionChange(room);
}

/** The current owner drops and stays away for the whole return window. */
function ownerDropsForGood(): Player {
  const owner = room.currentPlayer!;
  drop(owner.username);
  vi.advanceTimersByTime(OWNER_RETURN_WINDOW);
  return owner;
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
  rm.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the awaited photo owner goes away (EXP-029, DEC-035)", () => {
  it("a disconnected owner not back within OWNER_RETURN_WINDOW: another player is picked for the same round", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    vi.advanceTimersByTime(1_000);
    drop(owner.username);

    vi.advanceTimersByTime(OWNER_RETURN_WINDOW - 1);
    expect(waits()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // A fresh photo wait for round 1, the normal events: no round-skipped, the new owner gets a new request
    expect(events("round-skipped")).toHaveLength(0);
    expect(waits()).toEqual([{ round: 1, duration: PHOTO_WAIT_TIMEOUT }, { round: 1, duration: PHOTO_WAIT_TIMEOUT }]);
    const newOwner = room.currentPlayer!;
    expect(newOwner).not.toBe(owner);
    expect(newOwner.connected).toBe(true);
    expect(lastTurn()).toEqual({ target: newOwner.socketId, event: "your-turn", args: [{ round: 1, attempt: 2 }] });
    expect(room.round).toBe(0);
    expect(room._consecutiveSkips).toBe(0);

    // Its photo plays round 1
    engine.onPhotoReceived(room, PHOTO, newOwner.username);
    expect(events("round-start").map((e) => e.args[0])).toMatchObject([{ round: 1, photo: PHOTO }]);
  });

  it("the new owner gets the full wait: the gone owner's 15 s timer is gone", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    vi.advanceTimersByTime(10_000);
    ownerDropsForGood();
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1);
    expect(events("round-skipped")).toHaveLength(0);
    const newOwner = room.currentPlayer!;
    vi.advanceTimersByTime(1);
    // Room-wide without a reason, the new owner's own copy with it (EXP-110)
    expect(events("round-skipped").map((e) => [e.target, e.args[0]])).toEqual([
      [room.gameCode, { round: 1 }],
      [newOwner.socketId, { round: 1, reason: "timeout" }],
    ]);
  });

  it("an owner back within the window keeps their turn: no new pick, your-turn again, the photo is played", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    drop(owner.username);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW - 1_000);
    rejoin(owner.username);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW);
    expect(waits()).toHaveLength(1);
    expect(lastTurn()).toMatchObject({ target: owner.socketId, args: [{ round: 1, attempt: 1 }] });
    engine.onPhotoReceived(room, PHOTO, owner.username);
    expect(events("round-start")).toHaveLength(1);
  });

  it("other players' connection changes don't restart the window", () => {
    room = startedRoom(["alice", "bob", "carol", "dave"]);
    const owner = room.currentPlayer!;
    const others = room.players.filter((p) => p !== owner).map((p) => p.username);
    drop(owner.username);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW - 1_000);
    drop(others[0]);
    vi.advanceTimersByTime(1_000);
    expect(waits()).toHaveLength(2);
  });

  it("an owner who leaves the room: another player is picked at once", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    vi.advanceTimersByTime(2_000);
    leave(owner.username);
    expect(events("round-skipped")).toHaveLength(0);
    expect(waits()).toEqual([{ round: 1, duration: PHOTO_WAIT_TIMEOUT }, { round: 1, duration: PHOTO_WAIT_TIMEOUT }]);
    expect(room.players).toContain(room.currentPlayer);
    expect(room.currentPlayer).not.toBe(owner);
  });

  it("each player is picked at most once per round; with nobody left, the round is played again as a counted skip", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const first = ownerDropsForGood();
    rejoin(first.username);
    const second = ownerDropsForGood();
    expect(second).not.toBe(first); // the first is back, but already had this round
    rejoin(second.username);
    expect(events("round-skipped")).toHaveLength(0);
    const third = ownerDropsForGood();
    expect(new Set([first, second, third]).size).toBe(3);

    // Everyone had round 1 once: it starts over (announced like any repeated round), anyone back may be picked again
    // Its last owner is away: one room-wide announcement, no reason to anyone (EXP-110)
    expect(events("round-skipped").map((e) => e.args[0])).toEqual([{ round: 1 }]);
    expect(waits().map((w) => w.round)).toEqual([1, 1, 1, 1]);
    expect([first, second]).toContain(room.currentPlayer);
    expect(room.round).toBe(0);
    expect(room._consecutiveSkips).toBe(1); // replays count, so a stalled round ends the game (S2)
  });

  it("free owner changes never end the game nor count as skips, however many in a row", () => {
    room = startedRoom(["alice", "bob", "carol", "dave", "erin", "frank"]);
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS + 1; i++) ownerDropsForGood();
    expect(waits()).toHaveLength(MAX_CONSECUTIVE_SKIPS + 2);
    expect(events("round-skipped")).toHaveLength(0);
    expect(events("game-over")).toHaveLength(0);
    expect(room._consecutiveSkips).toBe(0);
    // ...while real timeouts still count
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT);
    expect(room._consecutiveSkips).toBe(1);
  });

  it("the game still plays its configured rounds: a re-picked round counts once", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const rounds = room.rounds;
    ownerDropsForGood();
    for (let r = 1; r <= rounds; r++) {
      engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ANSWER_TIME + 3_000 + 5_000); // answering, reveal, scores
    }
    expect(events("round-start").map((e) => (e.args[0] as { round: number }).round)).toEqual(
      Array.from({ length: rounds }, (_, i) => i + 1),
    );
    expect(events("game-over")).toHaveLength(1);
  });

  it("no new pick while paused; on resume an owner still away gets the window again", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    const [a, b] = room.players.filter((p) => p !== owner).map((p) => p.username);
    drop(owner.username);
    drop(a); // 1 connected: paused
    expect(room.paused).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(waits()).toHaveLength(1);

    rejoin(a);
    vi.advanceTimersByTime(PAUSE_MIN_DURATION);
    expect(room.paused).toBe(false);
    expect(waits()).toHaveLength(1);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW);
    expect(waits()).toHaveLength(2);
    expect(room.currentPlayer?.username).toMatch(new RegExp(`^(${a}|${b})$`));
    expect((lastTurn().args[0] as YourTurnData).round).toBe(1);
  });

  it("a re-drop after coming back gets a whole new window, not the rest of the old one (R1)", () => {
    room = startedRoom(["alice", "bob", "carol"]);
    const owner = room.currentPlayer!;
    drop(owner.username);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW - 1_000);
    rejoin(owner.username);
    vi.advanceTimersByTime(500);
    drop(owner.username);
    vi.advanceTimersByTime(1_000); // the old window would have ended here
    expect(waits()).toHaveLength(1);
    vi.advanceTimersByTime(OWNER_RETURN_WINDOW - 1_000);
    expect(waits()).toHaveLength(2);
  });

  it("past MAX_FREE_OWNER_CHANGES a disconnected owner gets the normal wait, and its timeout counts (S1)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // alice (first connected candidate) is picked whenever she can be
    room = startedRoom(["alice", "bob", "carol"]);
    const alice = player("alice");
    for (let round = 1; round <= MAX_FREE_OWNER_CHANGES; round++) {
      expect(room.currentPlayer).toBe(alice);
      ownerDropsForGood();
      rejoin("alice");
      engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ROUND_TIME);
    }
    expect(room._consecutiveSkips).toBe(0);
    // No free change left: no window, the whole 15 s wait, then a counted timeout skip
    expect(room.currentPlayer).toBe(alice);
    const waitsBefore = waits().length;
    drop("alice");
    vi.advanceTimersByTime(PHOTO_WAIT_TIMEOUT - 1);
    expect(waits()).toHaveLength(waitsBefore);
    vi.advanceTimersByTime(1);
    // alice is disconnected: only the room-wide announcement, without a reason (EXP-110)
    expect(events("round-skipped").map((e) => e.args[0])).toEqual([{ round: MAX_FREE_OWNER_CHANGES + 1 }]);
    expect(room._consecutiveSkips).toBe(1);
  });

  it("past MAX_FREE_OWNER_CHANGES, leaving still hands the round on at once but counts as a skip (S1)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // alice is picked whenever she can be
    room = startedRoom(["alice", "bob", "carol", "dave"]);
    for (let round = 1; round <= MAX_FREE_OWNER_CHANGES; round++) {
      ownerDropsForGood(); // alice
      rejoin("alice");
      engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ROUND_TIME);
    }
    expect(room.currentPlayer?.username).toBe("alice");
    const waitsBefore = waits().length;
    leave("alice");
    expect(waits()).toHaveLength(waitsBefore + 1);
    expect(events("round-skipped")).toHaveLength(0);
    expect(room._consecutiveSkips).toBe(1);
  });

  it("two colluders can't steer every round onto a victim by dropping on their turns (S1 probe)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the colluders come first: picked whenever they can be
    room = startedRoom(["a1", "a2", "victim"]);
    const owners: string[] = [];
    for (let guard = 0; room.started && guard < 500; guard++) {
      if (room.phase !== "waiting-photo" || !room.currentPlayer) { vi.advanceTimersByTime(100); continue; }
      const owner = room.currentPlayer.username;
      if (owner === "victim") {
        owners.push(owner);
        engine.onPhotoReceived(room, PHOTO, owner);
        while (room.started && room.phase !== "waiting-photo") vi.advanceTimersByTime(100);
      } else {
        // A colluder drops for the return window, then comes back (the other colluder stays connected)
        for (const n of ["a1", "a2"]) if (!player(n).connected) rejoin(n);
        drop(owner);
        vi.advanceTimersByTime(OWNER_RETURN_WINDOW + 10);
        rejoin(owner);
      }
    }
    // Their free changes give the victim MAX_FREE_OWNER_CHANGES rounds; then their timeouts count and end the game
    expect(owners).toHaveLength(MAX_FREE_OWNER_CHANGES);
    expect(events("game-over")).toHaveLength(1);
  });

  it("players dropping on every turn can't keep a round open forever (S2 probe)", () => {
    room = startedRoom(["a1", "a2", "a3"]);
    room.rounds = 3;
    for (let i = 0; room.started && i < 300; i++) {
      for (const n of ["a1", "a2", "a3"]) if (!player(n).connected) rejoin(n);
      if (room.phase !== "waiting-photo" || !room.currentPlayer) { vi.advanceTimersByTime(100); continue; }
      drop(room.currentPlayer.username);
      vi.advanceTimersByTime(OWNER_RETURN_WINDOW + 10);
    }
    expect(room.started).toBe(false);
    expect(events("game-over")).toHaveLength(1);
    expect(events("round-start")).toHaveLength(0);
  });

  it("a rejoin that resumes the game gets its snapshot before its your-turn; an owner who left gets none (R2, R5)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // the first connected candidate is picked: alice, then bob
    room = startedRoom(["alice", "bob", "carol"]);
    const alice = player("alice");
    expect(room.currentPlayer).toBe(alice);
    drop("bob");
    drop("carol"); // alice alone: paused
    expect(room.paused).toBe(true);
    leave("alice"); // the owner leaves while paused (its object keeps connected: true)
    vi.advanceTimersByTime(5_000);
    rejoin("carol");
    const from = emits.length;
    const bob = rejoin("bob"); // resumes the game; bob is picked as the new owner of round 1
    expect(room.paused).toBe(false);
    expect(room.currentPlayer).toBe(bob);

    const toBob = receivedBy(emits.slice(from), bob.socketId, room.gameCode).map((e) => e.event);
    expect(toBob).toEqual(["game-resumed", "game-state", "waiting-photo", "your-turn"]);
    // The owner who left is replaced, never asked again
    expect(emits.filter((e) => e.event === "your-turn" && e.target === alice.socketId)).toHaveLength(1);
    expect(waits().map((w) => w.round)).toEqual([1, 1]);
  });

  it("free owner changes are per game: a new game in the room gives them back", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // alice is picked whenever she can be
    room = startedRoom(["alice", "bob", "carol"]);
    room.rounds = MAX_FREE_OWNER_CHANGES;
    for (let round = 1; round <= MAX_FREE_OWNER_CHANGES; round++) {
      expect(room.currentPlayer?.username).toBe("alice");
      ownerDropsForGood();
      rejoin("alice");
      engine.onPhotoReceived(room, PHOTO, room.currentPlayer!.username);
      vi.advanceTimersByTime(ROUND_TIME);
    }
    expect(events("game-over")).toHaveLength(1);

    // Play again: alice drops on her turn and gets the return window, then a free owner change, again
    expect(engine.startGame(room)).toBe(true);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.currentPlayer?.username).toBe("alice");
    const waitsBefore = waits().length;
    ownerDropsForGood();
    expect(waits()).toHaveLength(waitsBefore + 1);
    expect(room.currentPlayer?.username).not.toBe("alice");
    expect(events("round-skipped")).toHaveLength(0);
    expect(room._consecutiveSkips).toBe(0);
  });
});
