import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { PAUSE_MIN_DURATION } from "../managers/GameEngine";
import { GAME_EVENT_LIMITS } from "../managers/socketGuards";
import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

// EXP-387: the app's Exit while its socket is offline. The reconnection is a new socket bound to no room; it used to
// rejoin the seat and leave right after, so a game paused longer than PAUSE_MIN_DURATION resumed for the others
// (game-resumed) and ended one round trip later. Now that socket's leave-room names the seat it gives up
// ({ gameCode, username, rejoinToken }): checked like a rejoin, removed as a leave, never bound nor resumed first.

const ACK_TIMEOUT_MS = 2_000;
const QUIET_MS = 400;
const LEAVE_BURST = GAME_EVENT_LIMITS["leave-room"].burst;

const { once, silent, newClient, joinAs, lobby, startGame } = useTestServer({ quietMs: QUIET_MS, resetBetweenTests: true });

const playerNames = (gameCode: string) => roomManager.getRoom(gameCode)?.players.map((p) => p.username) ?? [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** leave-room from `sock` naming `seat`, as the app's offline leave sends it; resolves on the ack (no data). */
const leaveSeat = (sock: ClientSocket, seat: unknown) => sock.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room", seat);

/** alice and bob playing (round 1 awaited); bob's connection drops and the game has been paused past its minimum. */
async function pausedForBob() {
  const { gameCode, alice, bob, tokens } = await lobby();
  await startGame(alice, [alice, bob]);
  const firstTurn = once(alice, "waiting-photo");
  [alice, bob].forEach((c) => c.emit("im-ready"));
  await firstTurn;
  const paused = once(alice, "game-paused");
  bob.disconnect();
  await paused;
  await sleep(PAUSE_MIN_DURATION + 200); // a rejoin now would resume the game at once
  const bobSeat = { gameCode, username: "bob", rejoinToken: tokens.bob };
  return { gameCode, alice, tokens, bobSeat };
}

describe("leave-room naming a seat, from a socket bound to no room (EXP-387)", () => {
  it("removes that player as a leave: the others get player-left and game-over, never game-resumed", async () => {
    const { gameCode, alice, bobSeat } = await pausedForBob();
    const left = once<string>(alice, "player-left");
    const over = once(alice, "game-over");
    const notResumed = silent(alice, "game-resumed", QUIET_MS + 400);

    const back = await newClient(); // bob's app, reconnected
    const noSnapshot = silent(back, "game-state");
    await expect(leaveSeat(back, bobSeat)).resolves.toBeUndefined();
    expect(playerNames(gameCode)).toEqual(["alice"]); // removed before the ack

    expect(await left).toBe("bob");
    await over;
    expect(await notResumed).toBe(true);
    expect(await noSnapshot).toBe(true); // never bound to the seat: nothing of the game reaches it
  }, 15_000);

  it("an old connection the server hasn't seen drop yet is cut off with the seat", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const left = once<string>(alice, "player-left");
    const cutOff = once<string>(bob, "disconnect");
    await leaveSeat(await newClient(), { gameCode, username: "bob", rejoinToken: tokens.bob });
    expect(await left).toBe("bob");
    expect(await cutOff).toBe("io server disconnect");
    expect(playerNames(gameCode)).toEqual(["alice"]);
  });

  it.each([
    ["a wrong token", (seat: { rejoinToken: string }, tokens: Record<string, string>) => ({ ...seat, rejoinToken: tokens.alice })],
    ["another player's name", (seat: object, tokens: Record<string, string>) => ({ ...seat, username: "alice", rejoinToken: tokens.bob })],
    ["a token of the wrong shape", (seat: object) => ({ ...seat, rejoinToken: 42 })],
    ["no seat at all", () => undefined],
  ])("with %s nothing happens (same ack, seat kept, the game stays paused)", async (_, makeSeat) => {
    const { gameCode, alice, tokens, bobSeat } = await pausedForBob();
    const noLeave = silent(alice, "player-left");
    const noEnd = silent(alice, "game-over");
    const stranger = await newClient();
    await expect(leaveSeat(stranger, makeSeat(bobSeat, tokens))).resolves.toBeUndefined();
    expect(await noLeave).toBe(true);
    expect(await noEnd).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(roomManager.getRoom(gameCode)?.paused).toBe(true);
  }, 15_000);

  it("a seat of another room is not touched", async () => {
    const { gameCode, alice, bobSeat } = await pausedForBob();
    const other = await newClient();
    const otherRoom = (await joinAs(other, null, "bob")).room!.gameCode; // a "bob" in another room
    const noLeave = silent(alice, "player-left");
    await expect(leaveSeat(await newClient(), { ...bobSeat, gameCode: otherRoom })).resolves.toBeUndefined();
    expect(await noLeave).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(playerNames(otherRoom)).toEqual(["bob"]);
  }, 15_000);

  it("a seat already left is not left twice (the name taken again by a newcomer stays)", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const seat = { gameCode, username: "bob", rejoinToken: tokens.bob };
    await bob.timeout(ACK_TIMEOUT_MS).emitWithAck("leave-room");
    const newBob = await newClient();
    expect((await joinAs(newBob, gameCode, "bob")).success).toBe(true); // the name is free again: a new player

    const noLeave = silent(alice, "player-left");
    await expect(leaveSeat(await newClient(), seat)).resolves.toBeUndefined();
    expect(await noLeave).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
  });

  it("from a bound socket the payload is ignored: it leaves its own seat, not the one named", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const left = once<string>(alice, "player-left");
    await leaveSeat(bob, { gameCode, username: "alice", rejoinToken: tokens.alice });
    expect(await left).toBe("bob");
    expect(playerNames(gameCode)).toEqual(["alice"]);
  });

  it("is rate limited like any leave-room: past the burst a valid seat is dropped, not acked", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const seat = { gameCode, username: "bob", rejoinToken: tokens.bob };
    const prober = await newClient();
    for (let i = 0; i < LEAVE_BURST; i++) await leaveSeat(prober, { ...seat, rejoinToken: tokens.alice });

    const noLeave = silent(alice, "player-left");
    await expect(leaveSeat(prober, seat)).rejects.toThrow(); // dropped: no ack
    expect(await noLeave).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(bob.connected).toBe(true);
  });
});
