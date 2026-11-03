import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { GameStateSnapshot, WaitingPhotoData } from "../models/interfaces";
import { useTestServer } from "./socketHarness";

// EXP-318: over the wire, game-started (3rd argument), waiting-photo and the rejoin's game-state carry the number of
// the game run in the room, so an app whose game ended while it was away tells a snapshot of the next game apart.

const ACK_TIMEOUT_MS = 2_000;

const { once, newClient, joinAs, lobby } = useTestServer({ resetBetweenTests: true });

/** game-started's arguments: (players, rounds, gameNumber) */
function gameStarted(sock: ClientSocket): Promise<unknown[]> {
  return new Promise((resolve) => sock.once("game-started", (...args: unknown[]) => resolve(args)));
}

/** The host starts a game and everyone sends im-ready: game-started's game number and the first waiting-photo. */
async function startToFirstWait(host: ClientSocket, all: ClientSocket[]) {
  const started = all.map(gameStarted);
  host.emit("start-game");
  const [first] = await Promise.all(started);
  const firstWait = once<WaitingPhotoData>(host, "waiting-photo");
  all.forEach((c) => c.emit("im-ready"));
  return { gameNumber: first[2], waiting: await firstWait };
}

describe("game number over the socket (EXP-318)", () => {
  it("numbers each game of the room in game-started, waiting-photo and the rejoin snapshot", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const game1 = await startToFirstWait(alice, [alice, bob]);
    expect(game1.gameNumber).toBe(1);
    expect(game1.waiting).toMatchObject({ round: 1, gameNumber: 1 });

    // Game 1 ends during its first photo wait: bob leaves, alice is alone
    const over = once(alice, "game-over");
    await bob.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    bob.disconnect();
    await over;

    // carol joins and the host plays again: game 2, at the very point where game 1 stopped
    const carol = await newClient();
    await joinAs(carol, gameCode, "carol");
    const game2 = await startToFirstWait(alice, [alice, carol]);
    expect(game2.gameNumber).toBe(2);
    expect(game2.waiting).toMatchObject({ round: 1, gameNumber: 2 });

    // alice rejoins on a new socket: her snapshot is of game 2
    const again = await newClient();
    const snapshot = once<GameStateSnapshot>(again, "game-state");
    await joinAs(again, gameCode, "alice", tokens.alice);
    expect(await snapshot).toMatchObject({ started: true, phase: "waiting-photo", round: 0, gameNumber: 2 });
  });
});
