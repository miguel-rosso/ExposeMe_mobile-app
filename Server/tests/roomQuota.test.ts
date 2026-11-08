import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine } from "../managers/GameEngine";
import { MAX_ROOMS, MAX_ROOMS_PER_IP, MAX_ROOMS_PER_IPV6_PREFIX, RoomManager, RoomQuota } from "../managers/RoomManager";
import { createFakeIo } from "./helpers";

// EXP-441: one IP must not be able to fill MAX_ROOMS. Rooms count against the quotas of the IP that created them while
// they live, and a room nobody can come back to (no players left) is deleted at once instead of being kept 30 min.

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;
const SOLO_ROOM_CLEANUP_DELAY = 2 * 60 * 1000;

let rm: RoomManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  rm = new RoomManager();
});

afterEach(() => {
  rm.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ipQuota = (key: string): RoomQuota => ({ key, max: MAX_ROOMS_PER_IP });

/** Creates rooms from `quotas` until they refuse one more; returns how many were created. */
function createUntilRefused(quotas: RoomQuota[]): number {
  let created = 0;
  while (rm.withinQuotas(quotas) && !rm.isAtCapacity()) {
    rm.createRoom(`host${created}`, `sock${created}`, quotas);
    created++;
  }
  return created;
}

describe("per-IP live-room quota", () => {
  it("defaults let several hosts share one NAT but keep one IP (or one IPv6 /48) far from the global cap", () => {
    expect(MAX_ROOMS_PER_IP).toBe(20);
    expect(MAX_ROOMS_PER_IPV6_PREFIX).toBe(100);
    expect(MAX_ROOMS_PER_IPV6_PREFIX * 10).toBeLessThan(MAX_ROOMS);
  });

  it("one IP exhausts its own quota, never the server's: another IP can still create", () => {
    const attacker = [ipQuota("203.0.113.7")];
    expect(createUntilRefused(attacker)).toBe(MAX_ROOMS_PER_IP);
    expect(rm.withinQuotas(attacker)).toBe(false);
    expect(rm.isAtCapacity()).toBe(false);
    expect(rm.withinQuotas([ipQuota("198.51.100.9")])).toBe(true);
  });

  it("counts every room an IP created while it lives, also after its creator left it to the guests", () => {
    const quotas = [ipQuota("203.0.113.7")];
    const room = rm.createRoom("alice", "sock-alice", quotas);
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.removePlayer(room.gameCode, "alice");
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(1);
  });

  it("a deleted room frees its slot", () => {
    const quotas = [ipQuota("203.0.113.7")];
    const room = rm.createRoom("alice", "sock-alice", quotas);
    rm.deleteRoom(room.gameCode);
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(0);
    rm.deleteRoom(room.gameCode); // deleting twice doesn't free a second slot
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(0);
  });

  it("a room with every player disconnected still counts until its deletion, then frees the slot", () => {
    const quotas = [ipQuota("203.0.113.7")];
    const room = rm.createRoom("alice", "sock-alice", quotas);
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 1);
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(0);
  });

  it("each quota of a room counts on its own: an IPv6 /48 caps all its /64s together", () => {
    const prefix: RoomQuota = { key: "2001:db8:1::/48", max: 3 };
    const first = [{ key: "2001:db8:1:1::/64", max: 2 }, prefix];
    const second = [{ key: "2001:db8:1:2::/64", max: 2 }, prefix];
    expect(createUntilRefused(first)).toBe(2); // its /64 is full
    expect(createUntilRefused(second)).toBe(1); // the /48 is full
    expect(rm.withinQuotas([{ key: "2001:db8:2:1::/64", max: 2 }, { key: "2001:db8:2::/48", max: 3 }])).toBe(true);
  });

  it("rooms created without quotas count against none", () => {
    rm.createRoom("alice", "sock-alice");
    expect(rm.withinQuotas([{ key: "203.0.113.7", max: 1 }])).toBe(true);
  });

  it("clear() forgets every count", () => {
    createUntilRefused([ipQuota("203.0.113.7")]);
    rm.clear();
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(0);
  });
});

describe("empty rooms are deleted at once", () => {
  it("the last player's leave deletes a room that had guests (nobody holds a token to come back with)", () => {
    const room = rm.createRoom("alice", "sock-alice", [ipQuota("203.0.113.7")]);
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.removePlayer(room.gameCode, "bob");
    room.started = true;
    room.round = 4;
    room.phase = "scores";
    expect(rm.removePlayer(room.gameCode, "alice")).toMatchObject({ removed: true, isEmpty: true });
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(rm.stats()).toEqual({ rooms: 0, pendingDeletions: 0 });
    expect(rm.roomsCreatedBy("203.0.113.7")).toBe(0);
    // The engine still sees the removed room's state after the removal: reset, so it starts no pause/lobby timer
    expect(room).toMatchObject({ started: false, round: 0, phase: null, currentPlayer: null });
  });

  it("a code whose room emptied is unknown: joining it answers Game not found", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.removePlayer(room.gameCode, "alice");
    expect(rm.joinRoom(room.gameCode, "bob", "sock-bob")).toEqual({ success: false, message: "Game not found" });
  });

  it("an emptied room's pending deletion is cancelled with it (disconnect all, then everybody leaves)", () => {
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    rm.markDisconnected(room.gameCode, "alice", "sock-alice");
    rm.markDisconnected(room.gameCode, "bob", "sock-bob");
    rm.removePlayer(room.gameCode, "bob");
    rm.removePlayer(room.gameCode, "alice");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the engine's leave of the last player in a running game leaves no timer behind", () => {
    const engine = new GameEngine(createFakeIo().io, rm);
    const room = rm.createRoom("alice", "sock-alice");
    rm.joinRoom(room.gameCode, "bob", "sock-bob");
    engine.startGame(room);
    engine.removePlayer(room, "bob", "left");
    engine.removePlayer(room, "alice", "left");
    expect(rm.getRoom(room.gameCode)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rooms whose players are only disconnected keep their retention (they can rejoin with their token)", () => {
    const solo = rm.createRoom("alice", "sock-alice");
    rm.markDisconnected(solo.gameCode, "alice", "sock-alice");
    vi.advanceTimersByTime(SOLO_ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(solo.gameCode)).toBe(solo);

    const party = rm.createRoom("carol", "sock-carol");
    rm.joinRoom(party.gameCode, "dave", "sock-dave");
    rm.removePlayer(party.gameCode, "carol");
    rm.markDisconnected(party.gameCode, "dave", "sock-dave");
    vi.advanceTimersByTime(ROOM_CLEANUP_DELAY - 1);
    expect(rm.getRoom(party.gameCode)).toBe(party);
  });
});
