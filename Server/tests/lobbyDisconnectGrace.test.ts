import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIME, GameEngine } from "../managers/GameEngine";
import { DISCONNECT_GRACE, RoomManager } from "../managers/RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { Room } from "../models/interfaces";
import { CapturedEmit, createFakeIo, registerTurnUpload } from "./helpers";

// EXP-157: a host gone from the lobby (disconnected > DISCONNECT_GRACE) hands the role to the next connected player,
// and the lobby is told who is gone. EXP-149: a game start only removes players gone for longer than the grace.
// Short absences (DEC-009) go unnoticed.

const GAME_START_DELAY = 1_000;
const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg";

let emits: CapturedEmit[];
let rm: RoomManager;
let engine: GameEngine;

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
  uploadStore.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function lobby(names: string[]): Room {
  const room = rm.createRoom(names[0], `sock-${names[0]}`);
  for (const n of names.slice(1)) rm.joinRoom(room.gameCode, n, `sock-${n}`);
  return room;
}

/** As socketRoutes does on a socket disconnect */
function drop(room: Room, name: string): void {
  const p = rm.getPlayer(room.gameCode, name)!;
  rm.markDisconnected(room.gameCode, name, p.socketId);
  engine.checkReady(room);
  engine.onConnectionChange(room);
}

/** As socketRoutes does on a rejoin (new socket, same token) */
function rejoin(room: Room, name: string, n = 2): void {
  const p = rm.getPlayer(room.gameCode, name)!;
  const res = rm.joinRoom(room.gameCode, name, `sock-${name}-${n}`, p.rejoinToken);
  expect(res).toMatchObject({ success: true, rejoin: true });
  engine.onPlayerRejoined(room, rm.getPlayer(room.gameCode, name)!);
}

const names = (room: Room) => room.players.map((p) => p.username);
const host = (room: Room) => room.players.filter((p) => p.isHost).map((p) => p.username);
const events = (event: string) => emits.filter((e) => e.event === event);

describe("lobby host handover after the disconnect grace (EXP-157)", () => {
  it("keeps the host during a short absence, hands over once the grace runs out", () => {
    const room = lobby(["alice", "bob", "carol"]);
    drop(room, "alice");
    vi.advanceTimersByTime(DISCONNECT_GRACE - 1);
    expect(host(room)).toEqual(["alice"]);
    expect(events("new-host")).toHaveLength(0);
    expect(events("player-connection")).toHaveLength(0);
    // public data doesn't show a short absence either
    expect(rm.publicPlayer(room.players[0]).connected).toBe(true);

    vi.advanceTimersByTime(1);
    expect(host(room)).toEqual(["bob"]);
    expect(events("player-connection").map((e) => e.args[0])).toEqual([{ username: "alice", connected: false }]);
    const nh = events("new-host");
    expect(nh).toHaveLength(1);
    expect(nh[0].args[0]).toMatchObject({ username: "bob", isHost: true });
    expect(nh[0].args[0]).not.toHaveProperty("rejoinToken");
    expect(rm.publicPlayer(room.players[0]).connected).toBe(false);
    expect(names(room)).toEqual(["alice", "bob", "carol"]); // still in the room, can come back
  });

  it("a host back within the grace stays host and nothing is announced", () => {
    const room = lobby(["alice", "bob"]);
    drop(room, "alice");
    vi.advanceTimersByTime(5_000);
    rejoin(room, "alice");
    vi.advanceTimersByTime(DISCONNECT_GRACE * 2);
    expect(host(room)).toEqual(["alice"]);
    expect(events("new-host")).toHaveLength(0);
    expect(events("player-connection")).toHaveLength(0);
  });

  it("the old host returning after the handover is a normal player (announced back)", () => {
    const room = lobby(["alice", "bob"]);
    drop(room, "alice");
    vi.advanceTimersByTime(DISCONNECT_GRACE);
    rejoin(room, "alice");
    expect(host(room)).toEqual(["bob"]);
    expect(rm.getPlayer(room.gameCode, "alice")!.isHost).toBe(false);
    expect(events("player-connection").map((e) => e.args[0])).toEqual([
      { username: "alice", connected: false },
      { username: "alice", connected: true },
    ]);
    // the new host can start, the old one can't
    expect(engine.startGame(room)).toEqual({ ok: true });
    expect(host(room)).toEqual(["bob"]);
  });

  it("skips players who are disconnected too: the first connected one becomes host", () => {
    const room = lobby(["alice", "bob", "carol"]);
    drop(room, "bob");
    drop(room, "alice");
    vi.advanceTimersByTime(DISCONNECT_GRACE);
    expect(host(room)).toEqual(["carol"]);
  });

  it("nobody connected: no handover until someone comes back", () => {
    const room = lobby(["alice", "bob"]);
    drop(room, "alice");
    drop(room, "bob");
    vi.advanceTimersByTime(DISCONNECT_GRACE);
    expect(host(room)).toEqual(["alice"]);
    rejoin(room, "bob");
    expect(host(room)).toEqual(["bob"]);
  });

  it("after a game: a host who dropped during the game hands over at game over", () => {
    const room = lobby(["alice", "bob", "carol"]);
    engine.startGame(room);
    room.players.forEach((p) => engine.markReady(room, p));
    vi.advanceTimersByTime(GAME_START_DELAY);
    drop(room, "alice");
    expect(host(room)).toEqual(["alice"]); // mid-game the role doesn't move
    room.rounds = room.round;
    const owner = room.currentPlayer!;
    registerTurnUpload(room.gameCode, owner.username, PHOTO, room.round + 1);
    engine.onPhotoReceived(room, PHOTO, owner.username);
    vi.advanceTimersByTime(ANSWER_TIME + 3_000 + 5_000 + 16_000);
    expect(room.started).toBe(false);
    expect(host(room)).toEqual(["bob"]);
  });

  it("re-arms the lobby timer for each grace: bob at 15 s, carol at 20 s, nothing earlier", () => {
    const room = lobby(["alice", "bob", "carol"]);
    const announced = () => events("player-connection").map((e) => e.args[0]);
    drop(room, "bob");
    vi.advanceTimersByTime(5_000);
    drop(room, "carol");
    vi.advanceTimersByTime(DISCONNECT_GRACE - 5_000 - 1); // t = 14.999 s
    expect(announced()).toEqual([]);
    vi.advanceTimersByTime(1); // t = 15 s
    expect(announced()).toEqual([{ username: "bob", connected: false }]);
    expect(room._lobbyTimer).not.toBeNull(); // re-armed for carol
    vi.advanceTimersByTime(5_000 - 1); // t = 19.999 s
    expect(announced()).toHaveLength(1);
    vi.advanceTimersByTime(1); // t = 20 s
    expect(announced()).toEqual([{ username: "bob", connected: false }, { username: "carol", connected: false }]);
    expect(room._lobbyTimer).toBeNull();
    expect(events("new-host")).toHaveLength(0); // alice (host) is still here
  });

  it("isGone: a disconnected player with no disconnect time counts as just disconnected", () => {
    const room = lobby(["alice", "bob"]);
    const bob = rm.getPlayer(room.gameCode, "bob")!;
    bob.connected = false;
    expect(rm.isGone(bob)).toBe(false);
  });

  it("a later host leave picks a connected player, not a gone one at the top of the list", () => {
    const room = lobby(["alice", "bob", "carol"]);
    drop(room, "alice");
    vi.advanceTimersByTime(DISCONNECT_GRACE);
    const res = rm.removePlayer(room.gameCode, "bob");
    expect(res.newHost?.username).toBe("carol");
    expect(host(room)).toEqual(["carol"]);
  });

  it("deleting the room cancels the lobby timer", () => {
    const room = lobby(["alice", "bob"]);
    drop(room, "bob");
    rm.deleteRoom(room.gameCode);
    expect(room._lobbyTimer).toBeNull();
  });
});

describe("game start keeps players within the disconnect grace (EXP-149)", () => {
  it("a player reconnecting right now (< grace) stays; one gone for longer is removed", () => {
    const room = lobby(["alice", "bob", "carol", "dave"]);
    drop(room, "dave");
    vi.advanceTimersByTime(DISCONNECT_GRACE + 1_000);
    drop(room, "carol");
    vi.advanceTimersByTime(1_500);
    expect(engine.startGame(room)).toEqual({ ok: true });
    expect(names(room)).toEqual(["alice", "bob", "carol"]);
    expect(events("player-left").map((e) => e.args[0])).toEqual(["dave"]);
    const started = events("game-started")[0].args[0] as { username: string }[];
    expect(started.map((p) => p.username)).toEqual(["alice", "bob", "carol"]);
    // carol comes back during the ready phase: a normal rejoin into the game
    rejoin(room, "carol");
    expect(rm.getPlayer(room.gameCode, "carol")!.connected).toBe(true);
  });

  it("a player within the grace who never returns doesn't block the start (ready phase goes on)", () => {
    const room = lobby(["alice", "bob", "carol"]);
    drop(room, "carol");
    expect(engine.startGame(room)).toEqual({ ok: true });
    expect(names(room)).toContain("carol");
    engine.markReady(room, room.players[0]);
    engine.markReady(room, room.players[1]);
    vi.advanceTimersByTime(GAME_START_DELAY);
    expect(room.phase).toBe("waiting-photo");
    expect(room.currentPlayer?.username).not.toBe("carol");
  });

  it("a start with only one other player reconnecting still starts (2 players kept)", () => {
    const room = lobby(["alice", "bob"]);
    drop(room, "bob");
    vi.advanceTimersByTime(1_000);
    expect(engine.startGame(room)).toEqual({ ok: true });
    expect(names(room)).toEqual(["alice", "bob"]);
  });
});
