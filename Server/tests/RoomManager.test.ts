import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomManager } from "../managers/RoomManager";

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;

let rm: RoomManager;

beforeEach(() => {
  vi.useFakeTimers();
  rm = new RoomManager();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("createRoom", () => {
  it("creates a lobby room with a 6-digit code and the creator as host", () => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(room.gameCode).toMatch(/^\d{6}$/);
    expect(room).toMatchObject({ rounds: 10, started: false, round: 0, phase: null, held: false, currentPlayer: null });
    expect(room.players).toEqual([
      { username: "alice", socketId: "sock-alice", isHost: true, isReady: false, points: 0, lastAnswerCorrect: false, lastGuess: "" },
    ]);
    expect(rm.getRoom(room.gameCode)).toBe(room);
  });

  it("generates distinct codes", () => {
    const codes = new Set(Array.from({ length: 50 }, (_, i) => rm.createRoom(`u${i}`, `s${i}`).gameCode));
    expect(codes.size).toBe(50);
  });
});

describe("joinRoom", () => {
  it("fails for an unknown code", () => {
    expect(rm.joinRoom("000000", "bob", "sock-bob")).toEqual({ success: false, message: "Game not found" });
  });

  it("adds a new non-host player", () => {
    const room = rm.createRoom("alice", "sock-alice");
    const res = rm.joinRoom(room.gameCode, "bob", "sock-bob");
    expect(res.success).toBe(true);
    expect(res.rejoin).toBeUndefined();
    expect(room.players.map((p) => [p.username, p.isHost])).toEqual([["alice", true], ["bob", false]]);
  });

  it("rejects new players once the game started", () => {
    const room = rm.createRoom("alice", "sock-alice");
    room.started = true;
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob")).toEqual({ success: false, message: "Game already started" });
  });

  it("lets an existing username rejoin (even mid-game) and updates its socket id", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    room.started = true;
    const res = rm.joinRoom(room.gameCode, "bob", "sock-bob-2");
    expect(res).toMatchObject({ success: true, rejoin: true });
    expect(room.players).toHaveLength(2);
    expect(rm.getPlayer(room.gameCode, "bob")!.socketId).toBe("sock-bob-2");
  });
});

describe("removePlayer", () => {
  it("returns removed=false for unknown room or player", () => {
    expect(rm.removePlayer("000000", "x")).toEqual({ removed: false, isEmpty: false });
    const room = rm.createRoom("alice", "sock-alice");
    expect(rm.removePlayer(room.gameCode, "x")).toEqual({ removed: false, isEmpty: false });
  });

  it("promotes the next player when the host leaves", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.joinRoom(room.gameCode, "carol", "sock-carol");
    const res = rm.removePlayer(room.gameCode, "alice");
    expect(res.removed).toBe(true);
    expect(res.isEmpty).toBe(false);
    expect(res.player!.username).toBe("alice");
    expect(res.newHost!.username).toBe("bob");
    expect(room.players.map((p) => [p.username, p.isHost])).toEqual([["bob", true], ["carol", false]]);
  });

  it("does not change host when a non-host leaves", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    const res = rm.removePlayer(room.gameCode, "bob");
    expect(res.newHost).toBeUndefined();
    expect(room.players[0].isHost).toBe(true);
  });

  it("resets an emptied room and deletes it after 30 minutes", () => {
    const room = rm.createRoom("alice", "sock-alice");
    room.started = true;
    room.round = 4;
    room.phase = "scores";
    const res = rm.removePlayer(room.gameCode, "alice");
    expect(res).toMatchObject({ removed: true, isEmpty: true });
    expect(room).toMatchObject({ started: false, round: 0, phase: null, currentPlayer: null, plantedPhotosShown: 0 });

    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    vi.advanceTimersByTime(1);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });

  it("cancels scheduled deletion when someone joins the emptied room (and they become host)", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.removePlayer(room.gameCode, "alice");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY / 2);
    const res = rm.joinRoom(room.gameCode, "bob", "sock-bob");
    expect(res.success).toBe(true);
    expect(room.players[0]).toMatchObject({ username: "bob", isHost: true });
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY);
    expect(rm.getRoom(room.gameCode)).toBe(room);
  });
});

describe("removePlayerBySocketId", () => {
  it("removes the matching player and returns it", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    expect(rm.removePlayerBySocketId(room.gameCode, "sock-bob")!.username).toBe("bob");
    expect(room.players.map((p) => p.username)).toEqual(["alice"]);
    expect(rm.removePlayerBySocketId(room.gameCode, "sock-bob")).toBeUndefined();
    expect(rm.removePlayerBySocketId("000000", "sock-alice")).toBeUndefined();
  });
});

describe("misc", () => {
  it("setRounds updates an existing room only", () => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(rm.setRounds(room.gameCode, 20)).toBe(true);
    expect(room.rounds).toBe(20);
    expect(rm.setRounds("000000", 20)).toBe(false);
  });

  it("safeRoomData strips timers, planted slots and the current player's planted photo", () => {
    const room = rm.createRoom("alice", "sock-alice");
    room.players[0].plantedPhoto = "https://example.invalid/p.jpg";
    room.currentPlayer = room.players[0];
    room.plantedSlots = new Set([3]);
    const safe = rm.safeRoomData(room) as Record<string, unknown>;
    for (const key of ["_timer", "_timerCallback", "_timerStartedAt", "_timerDuration", "_holdSafetyTimer", "plantedSlots"]) {
      expect(safe).not.toHaveProperty(key);
    }
    expect((safe.currentPlayer as { plantedPhoto?: string }).plantedPhoto).toBeUndefined();
    // original room untouched
    expect(room.currentPlayer.plantedPhoto).toBe("https://example.invalid/p.jpg");
  });

  // Possible leak (follow-up): safeRoomData only strips plantedPhoto from currentPlayer, not from room.players.
  it.todo("safeRoomData strips plantedPhoto from every player");

  it("deleteRoom clears the room timers and removes it", () => {
    const room = rm.createRoom("alice", "sock-alice");
    const cb = vi.fn();
    room._timer = setTimeout(cb, 1_000) as unknown as NodeJS.Timeout;
    room._holdSafetyTimer = setTimeout(cb, 1_000) as unknown as NodeJS.Timeout;
    room.held = true;
    rm.deleteRoom(room.gameCode);
    vi.advanceTimersByTime(2_000);
    expect(cb).not.toHaveBeenCalled();
    expect(room.held).toBe(false);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });
});
