import { describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

// EXP-213: leaving (leave-room) and a host kick (remove-player) both take a player out of the room through
// GameEngine.removePlayer. These pin what each path tells the room, in which order, and what it leaves behind
// (host role, pending room deletion, game state), so the shared removal keeps every path's observable behaviour.

const ACK_TIMEOUT_MS = 2_000;
/** Long enough for any broadcast caused by a handled event to reach every client on localhost. */
const QUIET_MS = 300;

// Every test plays in a lobby of its own, so each one's rooms and games (a paused one included) are dropped after it
const harness = useTestServer({ resetBetweenTests: true });
const { once, newClient, joinAs } = harness;

type Received = [event: string, ...args: unknown[]];

const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

/** Every event `socket` receives from now on, in order (connection lifecycle events excluded). */
function record(socket: ClientSocket): Received[] {
  const received: Received[] = [];
  socket.onAny((event: string, ...args: unknown[]) => received.push([event, ...args]));
  return received;
}

const eventNames = (received: Received[]) => received.map(([event]) => event);

/** A lobby with `names` joined in order (the first one creates the room and is the host). */
async function lobby(names: string[]): Promise<{ gameCode: string; sockets: ClientSocket[] }> {
  const host = await newClient();
  const gameCode = (await joinAs(host, null, names[0])).room!.gameCode;
  const sockets = [host];
  for (const name of names.slice(1)) {
    const guest = await newClient();
    const announced = sockets.map((c) => once(c, "player-joined"));
    expect((await joinAs(guest, gameCode, name)).success).toBe(true);
    await Promise.all(announced);
    sockets.push(guest);
  }
  return { gameCode, sockets };
}

/** The lobby's host starts the game; every socket has received game-started when this resolves. */
const startGame = (sockets: ClientSocket[]) => harness.startGame(sockets[0], sockets);

const room = (gameCode: string) => roomManager.getRoom(gameCode)!;
const playerNames = (gameCode: string) => room(gameCode).players.map((p) => p.username);
const player = (gameCode: string, username: string) => room(gameCode).players.find((p) => p.username === username)!;
const hostName = (gameCode: string) => room(gameCode).players.find((p) => p.isHost)?.username;

describe("leave-room removes the player (EXP-213)", () => {
  it("lobby: a guest's leave tells everyone player-left, the leaver included, and nothing else", async () => {
    const { gameCode, sockets } = await lobby(["alice", "bob", "carol"]);
    const received = sockets.map(record);

    await sockets[1].timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    await quiet();

    expect(playerNames(gameCode)).toEqual(["alice", "carol"]);
    expect(hostName(gameCode)).toBe("alice");
    for (const r of received) expect(r).toEqual([["player-left", "bob"]]);
  });

  it("lobby: the host's leave sends new-host (first connected player) before player-left", async () => {
    const { gameCode, sockets: [alice, bob] } = await lobby(["alice", "bob", "carol"]);
    const [atAlice, atBob] = [record(alice), record(bob)];

    await alice.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    await quiet();

    expect(hostName(gameCode)).toBe("bob");
    expect(eventNames(atBob)).toEqual(["new-host", "player-left"]);
    expect(atBob[0][1]).toMatchObject({ username: "bob", isHost: true });
    expect(atBob[1][1]).toBe("alice");
    // The leaver still hears its own removal: it leaves the socket.io room after the room is told
    expect(eventNames(atAlice)).toEqual(["new-host", "player-left"]);
  });

  it("the last player's leave deletes the emptied room at once (no broadcast, EXP-441)", async () => {
    const { gameCode, sockets: [alice] } = await lobby(["alice"]);
    const atAlice = record(alice);
    const pendingBefore = roomManager.stats().pendingDeletions;

    await alice.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    await quiet();

    expect(roomManager.getRoom(gameCode)).toBeUndefined();
    expect(roomManager.stats().pendingDeletions).toBe(pendingBefore);
    expect(atAlice).toEqual([]);
  });

  it("ready phase: a leave lets the game start when everyone left is ready", async () => {
    const { gameCode, sockets: [alice, bob, carol] } = await lobby(["alice", "bob", "carol"]);
    await startGame([alice, bob, carol]);
    bob.emit("im-ready");
    carol.emit("im-ready");
    await vi.waitFor(() => expect([player(gameCode, "bob").isReady, player(gameCode, "carol").isReady]).toEqual([true, true]));
    expect(room(gameCode).phase).toBeNull(); // still waiting for alice

    await alice.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");

    expect(room(gameCode).phase).toBe("waiting-photo");
  });

  it("mid-game: a leave that leaves one player connected pauses the game, after player-left", async () => {
    const { gameCode, sockets: [alice, bob, carol] } = await lobby(["alice", "bob", "carol"]);
    await startGame([alice, bob, carol]);
    const firstTurn = once(alice, "waiting-photo");
    [alice, bob, carol].forEach((c) => c.emit("im-ready"));
    await firstTurn;
    carol.disconnect(); // still within the disconnect grace: carol can come back, so the game pauses for her
    await vi.waitFor(() => expect(player(gameCode, "carol").connected).toBe(false));
    const atAlice = record(alice);

    await bob.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");

    expect(room(gameCode).paused).toBe(true);
    await vi.waitFor(() => expect(eventNames(atAlice)).toContain("game-paused"));
    expect(eventNames(atAlice).slice(0, 2)).toEqual(["player-left", "game-paused"]);
  });
});

describe("remove-player (host kick) removes the player (EXP-213)", () => {
  it("everyone, the kicked player included, gets player-removed; then the kicked player is cut off", async () => {
    const { gameCode, sockets: [alice, bob, carol] } = await lobby(["alice", "bob", "carol"]);
    const [atAlice, atBob, atCarol] = [record(alice), record(bob), record(carol)];
    const carolCutOff = once(carol, "disconnect");

    alice.emit("remove-player", { username: "carol" });
    await carolCutOff;
    await quiet();

    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(hostName(gameCode)).toBe("alice");
    for (const received of [atAlice, atBob, atCarol]) {
      expect(eventNames(received)).toEqual(["player-removed"]);
      expect(received[0][1]).toMatchObject({ username: "carol", isHost: false });
      expect(received[0][1]).not.toHaveProperty("rejoinToken");
    }
  });

  it("kicking the only guest keeps the room (no deletion scheduled) and the host stays host", async () => {
    const { gameCode, sockets: [alice, bob] } = await lobby(["alice", "bob"]);
    const atAlice = record(alice);
    const pendingBefore = roomManager.stats().pendingDeletions;
    const bobCutOff = once(bob, "disconnect");

    alice.emit("remove-player", { username: "bob" });
    await bobCutOff;
    await quiet();

    expect(playerNames(gameCode)).toEqual(["alice"]);
    expect(hostName(gameCode)).toBe("alice");
    expect(roomManager.stats().pendingDeletions).toBe(pendingBefore);
    expect(eventNames(atAlice)).toEqual(["player-removed"]);
  });

  it("an unknown username changes nothing and tells nobody", async () => {
    const { gameCode, sockets: [alice, bob] } = await lobby(["alice", "bob"]);
    const [atAlice, atBob] = [record(alice), record(bob)];

    alice.emit("remove-player", { username: "nobody" });
    await quiet();

    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(atAlice).toEqual([]);
    expect(atBob).toEqual([]);
  });
});
