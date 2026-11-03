import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-425 / DEC-052 A: remove-player is taken during a game too, from the host only (checked on the session, never the
// payload) and never on the host itself. Everyone, the kicked player included, gets player-removed; then the kicked
// player's socket is closed and their rejoin token revoked, so their app coming back with it is refused with
// "Removed by host" (EXP-337), checked before "Game already started". The game goes on for the others.

const t = useTestServer({ resetBetweenTests: true });

const PHOTO = "/temp/" + "f".repeat(32) + ".jpg";
const playerNames = (gameCode: string) => roomManager.getRoom(gameCode)!.players.map((p) => p.username);

/** alice (host), bob and carol in round 1's answering phase. Returns the photo owner too. */
async function gameInRound() {
  const { gameCode, alice, bob, tokens } = await t.lobby();
  const carol = await t.newClient();
  tokens.carol = (await t.joinAs(carol, gameCode, "carol")).rejoinToken!;
  const sockets: Record<string, ClientSocket> = { alice, bob, carol };
  await t.startGame(alice, Object.values(sockets));
  const turn = Promise.race(Object.entries(sockets).map(([name, c]) => t.once(c, "your-turn").then(() => name)));
  Object.values(sockets).forEach((c) => c.emit("im-ready"));
  const owner = await turn;
  registerTurnUpload(gameCode, owner, PHOTO, 1);
  const started = Object.values(sockets).map((c) => t.once(c, "round-start"));
  sockets[owner].emit("photo-sent", { photo: PHOTO });
  await Promise.all(started);
  return { gameCode, sockets, tokens, owner };
}

describe("remove-player during a game (EXP-425)", () => {
  it("the host removes a player mid-round: everyone is told, the kicked socket is closed, the game goes on", async () => {
    const { gameCode, sockets } = await gameInRound();
    const told = ["alice", "bob", "carol"].map((n) => t.once<{ username: string }>(sockets[n], "player-removed"));
    const closed = t.once(sockets.carol, "disconnect");

    sockets.alice.emit("remove-player", { username: "carol" });

    expect((await Promise.all(told)).map((p) => p.username)).toEqual(["carol", "carol", "carol"]);
    await closed;
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
    expect(roomManager.getRoom(gameCode)).toMatchObject({ started: true, phase: "answering" });
  });

  it("the kicked player can't come back with their token: \"Removed by host\", and the room hears nothing", async () => {
    const { gameCode, sockets, tokens } = await gameInRound();
    const closed = t.once(sockets.bob, "disconnect");
    sockets.alice.emit("remove-player", { username: "bob" });
    await closed;
    const back = await t.newClient();
    const hostHears = t.silent(sockets.alice, "player-joined");

    expect(await t.joinAs(back, gameCode, "bob", tokens.bob)).toEqual({ success: false, message: "Removed by host" });
    expect(await hostHears).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "carol"]);
  });

  it("a kick that leaves the host alone ends the game", async () => {
    const { gameCode, alice, bob } = await t.lobby();
    await t.startGame(alice, [alice, bob]);
    const over = t.once(alice, "game-over");

    alice.emit("remove-player", { username: "bob" });

    await over;
    expect(roomManager.getRoom(gameCode)).toMatchObject({ started: false });
    expect(playerNames(gameCode)).toEqual(["alice"]);
  });

  it("is ignored from anyone but the host, and on the host itself", async () => {
    const { gameCode, sockets } = await gameInRound();
    const quiet = Object.values(sockets).map((c) => t.silent(c, "player-removed"));

    sockets.bob.emit("remove-player", { username: "carol" });
    sockets.bob.emit("remove-player", { gameCode, username: "carol" }); // a room in the payload changes nothing
    sockets.alice.emit("remove-player", { username: "alice" });

    expect(await Promise.all(quiet)).toEqual([true, true, true]);
    expect(Object.values(sockets).every((c) => c.connected)).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice", "bob", "carol"]);
  });
});
