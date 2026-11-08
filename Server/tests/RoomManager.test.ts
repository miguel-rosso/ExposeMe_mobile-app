import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PLAYERS_PER_ROOM, MAX_REVOKED_TOKENS_PER_ROOM, RoomManager } from "../managers/RoomManager";

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
  it("creates a lobby room with a 6-character code and the creator as host", () => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(room.gameCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(room).toMatchObject({ rounds: 10, started: false, round: 0, phase: null, held: false, currentPlayer: null });
    expect(room.players).toEqual([
      { username: "alice", socketId: "sock-alice", isHost: true, isReady: false, connected: true, points: 0, lastAnswerCorrect: false, lastGuess: "", rejoinToken: expect.any(String) },
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

  it("lets an existing username rejoin with its token (even mid-game) and updates its socket id", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    const token = rm.getPlayer(room.gameCode, "bob")!.rejoinToken;
    room.started = true;
    const res = rm.joinRoom(room.gameCode, "bob", "sock-bob-2", token);
    expect(res).toMatchObject({ success: true, rejoin: true });
    expect(room.players).toHaveLength(2);
    expect(rm.getPlayer(room.gameCode, "bob")!.socketId).toBe("sock-bob-2");
  });

  it("gives every player a distinct random token", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    const [a, b] = room.players.map((p) => p.rejoinToken);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(a).not.toBe(b);
  });

  it("rejects an existing username without the matching token and keeps its socket id", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    const aliceToken = room.players[0].rejoinToken;
    for (const token of [undefined, "", "wrong", aliceToken]) {
      expect(rm.joinRoom(room.gameCode, "bob", "sock-x", token)).toEqual({ success: false, message: "Username already taken" });
    }
    room.started = true;
    expect(rm.joinRoom(room.gameCode, "bob", "sock-x")).toEqual({ success: false, message: "Game already started" });
    expect(rm.getPlayer(room.gameCode, "bob")!.socketId).toBe("sock-bob");
  });

  // EXP-032: a name that reads the same as a player's on screen is that player's name
  it.each([
    ["math bold letters", "bob", "\u{1D41B}\u{1D428}\u{1D41B}"],
    ["case variant", "bob", "Bob"],
    ["Cyrillic o", "bob", "b\u043Eb"],
    ["full-width", "bob", "\uFF42\uFF4F\uFF42"],
    ["accent", "Jose", "Jos\u00E9"],
    ["Latin small capital", "Dave", "D\u1D00ve"],
    ["Cherokee", "Dave", "\u13A0\u13AA\u13D9\u13AC"],
    ["box-drawing line as l", "Alice", "A\u2502ice"],
    ["long s as f", "Rafe", "Ra\u017Fe"],
    ["all-Cyrillic with small ka", "Mike", "\u041C\u0456\u043A\u0435"],
    ["Hebrew drawn reversed", "Milo", "Mi\u05E1\u05D5"],
    ["kaomoji with full-width brackets", "(\u2022_\u2022)", "\uFF08\u2022_\u2022\uFF09"],
  ])("refuses another spelling of an existing name (%s), even with that player's token", (_label, existing, lookalike) => {
    const room = rm.createRoom("host", "sock-host");
    rm.joinRoom(room.gameCode, existing, "sock-existing");
    const existingToken = rm.getPlayer(room.gameCode, existing)!.rejoinToken;
    for (const token of [undefined, existingToken]) {
      expect(rm.joinRoom(room.gameCode, lookalike, "sock-x", token)).toEqual({ success: false, message: "Username already taken" });
    }
    room.started = true;
    expect(rm.joinRoom(room.gameCode, lookalike, "sock-x")).toEqual({ success: false, message: "Game already started" });
    expect(room.players.map((p) => p.username)).toEqual(["host", existing]);
    expect(rm.getPlayer(room.gameCode, existing)!.socketId).toBe("sock-existing");
  });

  it.each([
    ["capital I as l", "Alice", "AIice"],
    ["rn as m", "Mike", "rnike"],
    ["cl as d", "Dara", "Clara"],
    ["Arabic alef as I (UTS #39 reads it as l)", "XI", "X\u0627"],
    ["bullet operator as a bullet", "(\u2022_\u2022)", "(\u2219_\u2219)"],
    ["retroflex clicks as exclamation marks", "!!", "\u01C3\u01C3"],
  ])("refuses a name that only looks like an existing one (%s) as too similar", (_label, existing, lookalike) => {
    const room = rm.createRoom("host", "sock-host");
    rm.joinRoom(room.gameCode, existing, "sock-existing");
    const existingToken = rm.getPlayer(room.gameCode, existing)!.rejoinToken;
    for (const token of [undefined, existingToken]) {
      expect(rm.joinRoom(room.gameCode, lookalike, "sock-x", token)).toEqual({ success: false, message: "Username too similar" });
    }
    room.started = true;
    expect(rm.joinRoom(room.gameCode, lookalike, "sock-x")).toEqual({ success: false, message: "Game already started" });
    expect(room.players.map((p) => p.username)).toEqual(["host", existing]);
  });

  it("still admits distinct names and rejoins with the exact stored name", () => {
    const room = rm.createRoom("BoB", "sock-bob");
    expect(rm.joinRoom(room.gameCode, "rob", "sock-rob").success).toBe(true);
    expect(rm.joinRoom(room.gameCode, "bobby", "sock-bobby").success).toBe(true);
    const token = room.players[0].rejoinToken;
    expect(rm.joinRoom(room.gameCode, "BoB", "sock-bob-2", token)).toMatchObject({ success: true, rejoin: true });
    expect(room.players.map((p) => p.username)).toEqual(["BoB", "rob", "bobby"]);
  });

  it("answers a full room before comparing names, and still lets its players rejoin", () => {
    const room = rm.createRoom("bob", "sock-0");
    for (let i = 1; i < MAX_PLAYERS_PER_ROOM; i++) rm.joinRoom(room.gameCode, `player${i}`, `sock-${i}`);
    for (const name of ["Bob", "b0b", "carol"]) {
      expect(rm.joinRoom(room.gameCode, name, "sock-x")).toEqual({ success: false, message: "Room is full" });
    }
    const token = room.players[0].rejoinToken;
    expect(rm.joinRoom(room.gameCode, "bob", "sock-0b", token)).toMatchObject({ success: true, rejoin: true });
  });

  it("lets a socket switch to a lookalike of its own name (the replaced slot doesn't count)", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    expect(rm.joinRoom(room.gameCode, "Bob", "sock-bob", undefined, "bob")).toMatchObject({ success: true });
  });
});

// EXP-337: a kicked player's app that missed player-removed (offline) comes back with its old token. That join is
// refused with its own reason instead of entering as a new player; a join without the token still enters (DEC-016).
describe("revokeRejoinToken", () => {
  /** Lobby alice (host) + bob; bob is kicked: removed and his token revoked, as remove-player does. */
  const kickBob = () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    const token = rm.getPlayer(room.gameCode, "bob")!.rejoinToken;
    rm.removePlayer(room.gameCode, "bob");
    rm.revokeRejoinToken(room, token);
    return { room, token };
  };

  it("refuses a join that carries the kicked player's token, and lets nobody in", () => {
    const { room, token } = kickBob();
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob-2", token)).toEqual({ success: false, message: "Removed by host" });
    expect(room.players.map((p) => p.username)).toEqual(["alice"]);
  });

  it("tells the kicked player so even once a game started (before \"Game already started\")", () => {
    const { room, token } = kickBob();
    room.started = true;
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob-2", token)).toMatchObject({ message: "Removed by host" });
  });

  it("lets the same name join again by hand (no token) as a new player with a new token", () => {
    const { room, token } = kickBob();
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob-2")).toEqual({ success: true, room });
    const bob = rm.getPlayer(room.gameCode, "bob")!;
    expect(bob.rejoinToken).not.toBe(token);
    expect(bob.points).toBe(0);
  });

  it("only applies in the room that kicked them", () => {
    const { token } = kickBob();
    const other = rm.createRoom("carol", "sock-carol");
    expect(rm.joinRoom(other.gameCode, "bob", "sock-bob-2", token)).toMatchObject({ success: true });
  });

  it(`remembers at most ${MAX_REVOKED_TOKENS_PER_ROOM} tokens per room, forgetting the oldest`, () => {
    const room = rm.createRoom("alice", "sock-alice");
    // Shaped like real tokens (24 base64url characters): anything else is treated as no token at all
    const tokens = Array.from({ length: MAX_REVOKED_TOKENS_PER_ROOM + 1 }, (_, i) => `kicked-token-${i}`.padEnd(24, "x"));
    tokens.forEach((token) => rm.revokeRejoinToken(room, token));
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob", tokens[0])).toMatchObject({ success: true });
    expect(rm.joinRoom(room.gameCode, "dan", "sock-dan", tokens[1])).toMatchObject({ message: "Removed by host" });
  });
});

// A join's token is compared with every player's and every revoked one: a value that can't be a token (not 24
// base64url characters, e.g. a megabyte-long string) is treated as no token, without copying or comparing it
describe("rejoin token shape", () => {
  const HUGE_TOKEN = "A".repeat(1024 * 1024);

  it.each([
    ["a huge string", HUGE_TOKEN],
    ["one character short", "A".repeat(23)],
    ["one character long", "A".repeat(25)],
    ["non-base64url characters", "A".repeat(23) + "+"],
    ["a number", 123],
    ["an object", { length: 24 }],
  ])("treats %s as no token: no rejoin, a plain new-player answer", (_label, token) => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(rm.canRejoin(room.gameCode, "alice", token)).toBe(false);
    expect(rm.joinRoom(room.gameCode, "alice", "sock-x", token)).toEqual({ success: false, message: "Username already taken" });
    expect(rm.authenticate(room.gameCode, token as string)).toBeNull();
  });

  it("never copies a token of the wrong length to compare it", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.revokeRejoinToken(room, "B".repeat(24));
    const from = vi.spyOn(Buffer, "from");
    rm.joinRoom(room.gameCode, "bob", "sock-bob", HUGE_TOKEN);
    rm.authenticate(room.gameCode, HUGE_TOKEN);
    expect(from.mock.calls.some(([value]) => value === HUGE_TOKEN)).toBe(false);
    from.mockRestore();
  });

  it("still rejoins with a real token", () => {
    const room = rm.createRoom("alice", "sock-alice");
    const token = room.players[0].rejoinToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(rm.joinRoom(room.gameCode, "alice", "sock-alice-2", token)).toMatchObject({ success: true, rejoin: true });
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

  it("resets an emptied room and deletes it at once (EXP-441)", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob"); // had a second player: not kept 30 min either
    rm.removePlayer(room.gameCode, "bob");
    room.started = true;
    room.round = 4;
    room.phase = "scores";
    const res = rm.removePlayer(room.gameCode, "alice");
    expect(res).toMatchObject({ removed: true, isEmpty: true });
    expect(room).toMatchObject({ started: false, round: 0, phase: null, currentPlayer: null, plantedPhotosShown: 0 });
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(rm.stats()).toEqual({ rooms: 0, pendingDeletions: 0 });
  });

  it("a room whose remaining players are only disconnected is kept for them until its deletion", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "carol", "sock-carol");
    rm.markDisconnected(room.gameCode, "carol", "sock-carol");
    rm.removePlayer(room.gameCode, "alice");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(room.gameCode)).toBe(room);
    vi.advanceTimersByTime(1);
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
  });
});

describe("misc", () => {
  it("setRounds updates an existing room only", () => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(rm.setRounds(room.gameCode, 20)).toBe(true);
    expect(room.rounds).toBe(20);
    expect(rm.setRounds("000000", 20)).toBe(false);
  });

  it("safeRoomData strips timers, planted slots and the current player", () => {
    const room = rm.createRoom("alice", "sock-alice");
    room.players[0].plantedPhoto = "https://example.invalid/p.jpg";
    room.currentPlayer = room.players[0];
    room.plantedSlots = new Set([3]);
    const safe = rm.safeRoomData(room) as unknown as Record<string, unknown>;
    for (const key of ["_timer", "_timerCallback", "_timerStartedAt", "_timerDuration", "_holdSafetyTimer", "plantedSlots", "currentPlayer"]) {
      expect(safe).not.toHaveProperty(key);
    }
    // original room untouched
    expect(room.currentPlayer.plantedPhoto).toBe("https://example.invalid/p.jpg");
  });

  it("safeRoomData strips plantedPhoto, rejoinToken and socketId from every player", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    room.players[1].plantedPhoto = "https://example.invalid/p.jpg";
    room.currentPlayer = room.players[1];
    const safe = rm.safeRoomData(room);
    for (const p of safe.players) {
      expect(p).not.toHaveProperty("plantedPhoto");
      expect(p).not.toHaveProperty("rejoinToken");
      expect(p).not.toHaveProperty("socketId");
    }
    expect(room.players[1].rejoinToken).toBeTruthy();
  });

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

// ── Connection state (EXP-018) ─────────────────────────

describe("connection state", () => {
  it("new players start connected", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    expect(room.players.map((p) => p.connected)).toEqual([true, true]);
  });

  it("markDisconnected flags the player only when the socket is their current one", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.joinRoom(room.gameCode, "bob", "sock-bob-2", rm.getPlayer(room.gameCode, "bob")!.rejoinToken); // rejoin with a new socket
    // stale socket disconnecting must not mark bob offline
    expect(rm.markDisconnected(room.gameCode, "bob", "sock-bob")).toBeUndefined();
    expect(rm.getPlayer(room.gameCode, "bob")!.connected).toBe(true);

    expect(rm.markDisconnected(room.gameCode, "bob", "sock-bob-2")!.username).toBe("bob");
    expect(rm.getPlayer(room.gameCode, "bob")!.connected).toBe(false);
  });

  it("rejoin marks the player connected again", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    room.started = true;
    rm.joinRoom(room.gameCode, "bob", "sock-bob-2", rm.getPlayer(room.gameCode, "bob")!.rejoinToken);
    expect(rm.getPlayer(room.gameCode, "bob")!.connected).toBe(true);
  });

  it("safeRoomData does not expose the skip counter", () => {
    const room = rm.createRoom("alice", "sock-alice");
    expect(rm.safeRoomData(room)).not.toHaveProperty("_consecutiveSkips");
  });
});
