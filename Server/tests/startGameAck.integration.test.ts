import { describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { DISCONNECT_GRACE } from "../managers/RoomManager";
import { GAME_EVENT_LIMITS } from "../managers/socketGuards";
import type { StartGameAck } from "../models/interfaces";
import { useTestServer } from "./socketHarness";

// EXP-379: start-game is acknowledged, so the host's Start button can show it is starting and, when the server
// refuses (e.g. the only other player was gone and the start removed them), say why instead of silently flipping
// back to "Waiting for players".

const ACK_WAIT_MS = 2_000;

const { once, newClient, joinAs, lobby } = useTestServer({ resetBetweenTests: true });

/** start-game with an ack callback: the server's answer, or null if none came in time. */
function start(c: ClientSocket): Promise<StartGameAck | null> {
  return c.timeout(ACK_WAIT_MS).emitWithAck("start-game").catch(() => null);
}

/** `username` dropped and has been away for the whole grace: the next start removes them. */
async function makeGone(gameCode: string, username: string, socket: ClientSocket): Promise<void> {
  socket.disconnect();
  await vi.waitFor(() => expect(roomManager.getPlayer(gameCode, username)?.connected).toBe(false));
  roomManager.getPlayer(gameCode, username)!.disconnectedAt = Date.now() - DISCONNECT_GRACE;
}

describe("start-game acknowledgement (EXP-379)", () => {
  it("ok for the host, after game-started reached the room", async () => {
    const { alice, bob } = await lobby();
    const events: string[] = [];
    alice.once("game-started", () => events.push("game-started"));
    const bobStarted = once(bob, "game-started");
    const ack = await start(alice);
    events.push("ack");
    expect(ack).toEqual({ ok: true });
    expect(events).toEqual(["game-started", "ack"]);
    await bobStarted;
  });

  it("not-in-room from a socket bound to no room", async () => {
    const stranger = await newClient();
    expect(await start(stranger)).toEqual({ ok: false, reason: "not-in-room" });
  });

  it("not-host from a guest; the game does not start", async () => {
    const { gameCode, bob } = await lobby();
    expect(await start(bob)).toEqual({ ok: false, reason: "not-host" });
    expect(roomManager.getRoom(gameCode)!.started).toBe(false);
  });

  it("already-started while a game is running; no second game-started", async () => {
    const { gameCode, alice } = await lobby();
    expect(await start(alice)).toEqual({ ok: true });
    const gameNumber = roomManager.getRoom(gameCode)!.gameNumber;
    expect(await start(alice)).toEqual({ ok: false, reason: "already-started" });
    expect(roomManager.getRoom(gameCode)!.gameNumber).toBe(gameNumber);
  });

  it("not-enough-players naming the gone players the start removed (player-left came first)", async () => {
    const { gameCode, alice, bob } = await lobby();
    const carol = await newClient();
    expect((await joinAs(carol, gameCode, "carol")).success).toBe(true);
    await makeGone(gameCode, "bob", bob);
    await makeGone(gameCode, "carol", carol);
    const left: string[] = [];
    alice.on("player-left", (name: string) => left.push(name));

    const ack = await start(alice);
    expect(ack).toEqual({ ok: false, reason: "not-enough-players", removed: ["bob", "carol"] });
    expect(left).toEqual(["bob", "carol"]);
    expect(roomManager.getRoom(gameCode)!.started).toBe(false);
  });

  it("not-enough-players with nobody removed when the host is alone", async () => {
    const alice = await newClient();
    expect((await joinAs(alice, null, "alice")).success).toBe(true);
    expect(await start(alice)).toEqual({ ok: false, reason: "not-enough-players", removed: [] });
  });

  it("no ack for an event dropped by the rate limit", async () => {
    const stranger = await newClient();
    const answers = await Promise.all(Array.from({ length: GAME_EVENT_LIMITS["start-game"].burst + 1 }, () => start(stranger)));
    expect(answers.slice(0, -1).every((a) => a?.ok === false)).toBe(true);
    expect(answers[answers.length - 1]).toBeNull();
  });
});
