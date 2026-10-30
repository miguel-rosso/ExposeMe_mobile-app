import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

// EXP-254: leave-room is acked once the server has handled it. The app closes its socket only on that ack: an event
// that socket.io dispatches after the disconnect is dropped, and the leave then looks like a lost connection (lobby:
// the player lingers as gone; mid-game: the game pauses waiting for them instead of ending).

const ACK_TIMEOUT_MS = 2_000;
const QUIET_MS = 300;

// Every test plays in a lobby of its own (or in none), so each one's rooms and games are dropped after it
const { once, silent, newClient, lobby, startGame } = useTestServer({ quietMs: QUIET_MS, resetBetweenTests: true });

/** Like the app's Exit: leave-room, and close the socket once the server acks it. */
async function leaveLikeTheApp(sock: ClientSocket): Promise<void> {
  await sock.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
  sock.disconnect();
}

const playerNames = (gameCode: string) => roomManager.getRoom(gameCode)?.players.map((p) => p.username) ?? [];

describe("leave-room ack (EXP-254)", () => {
  it("acks only after the player is removed, so closing the socket on the ack is a voluntary leave", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    const noConnectionChange = silent(alice, "player-connection");

    await bob.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    expect(playerNames(gameCode)).toEqual(["alice"]); // handled before the ack
    bob.disconnect();

    expect(await left).toBe("bob");
    expect(await noConnectionChange).toBe(true); // never shown as a lost connection
  });

  it("the host's leave hands the host role over before the ack", async () => {
    const { gameCode, alice, bob } = await lobby();
    const newHost = once<{ username: string }>(bob, "new-host");

    await leaveLikeTheApp(alice);
    expect(roomManager.getRoom(gameCode)?.players.map((p) => [p.username, p.isHost])).toEqual([["bob", true]]);
    expect((await newHost).username).toBe("bob");
  });

  it("mid-game, a leave closed on the ack ends a 2-player game instead of pausing it", async () => {
    const { alice, bob } = await lobby();
    await startGame(alice, [alice, bob]);
    const firstTurn = once(alice, "waiting-photo");
    [alice, bob].forEach((c) => c.emit("im-ready"));
    await firstTurn;

    const gameOver = once(alice, "game-over");
    const notPaused = silent(alice, "game-paused");
    await leaveLikeTheApp(bob);

    await gameOver;
    expect(await notPaused).toBe(true);
  });

  it("ready phase, a leave closed on the ack ends a 2-player game at once, before the ready timeout (EXP-338)", async () => {
    const { alice, bob } = await lobby();
    await startGame(alice, [alice, bob]);
    alice.emit("im-ready");

    // Well under READY_TIMEOUT (10 s): the game ends on the leave, not when the first round would start
    const gameOver = once<{ finalScore: { username: string; points: number }[] }>(alice, "game-over", 1_500);
    const noRound = silent(alice, "waiting-photo");
    const notPaused = silent(alice, "game-paused");
    await leaveLikeTheApp(bob);

    expect((await gameOver).finalScore.map((s) => [s.username, s.points])).toEqual([["alice", 0]]);
    expect(await noRound).toBe(true);
    expect(await notPaused).toBe(true);
  });

  it("ready phase, an im-ready sent after a missed game-over gets the finished game's game-state (EXP-338)", async () => {
    const { alice, bob } = await lobby();
    await startGame(alice, [alice, bob]);
    // bob leaves while alice is still on her way to the game screen: nobody listens for her game-over yet
    await leaveLikeTheApp(bob);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));

    const snapshot = once<{ started: boolean; scores: { username: string; points: number }[] }>(alice, "game-state", 1_500);
    alice.emit("im-ready"); // the game screen mounted
    const snap = await snapshot;
    expect(snap.started).toBe(false);
    expect(snap.scores.map((s) => [s.username, s.points])).toEqual([["alice", 0]]);
  });

  it("a socket bound to no room gets the ack too (nothing to leave)", async () => {
    const stranger = await newClient();
    await expect(stranger.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room")).resolves.toBeUndefined();
  });
});
