import { describe, expect, it } from "vitest";
import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

// EXP-337: a player kicked while their phone was offline never got player-removed. When the app came back it rejoined
// with its stored token and the server let it in as a new player, so the host saw them reappear (player-joined).
// Now that join is refused with "Removed by host" (the app shows the kick notice and forgets the token); joining
// again by hand, without the token, still enters as a new player (DEC-016).

const t = useTestServer({ resetBetweenTests: true });

const playerNames = (gameCode: string) => roomManager.getRoom(gameCode)!.players.map((p) => p.username);

/** alice (host) + bob; bob's phone goes offline, then alice kicks him. Returns bob's old token. */
async function kickOfflineBob() {
  const { gameCode, alice, bob, tokens } = await t.lobby();
  const bobOffline = t.once(bob, "disconnect");
  bob.disconnect();
  await bobOffline;
  alice.emit("remove-player", { username: "bob" });
  await t.once(alice, "player-removed");
  return { gameCode, alice, bobToken: tokens.bob };
}

describe("a kicked player's old token (EXP-337)", () => {
  it("a rejoin with it is refused with \"Removed by host\" and the host hears nothing", async () => {
    const { gameCode, alice, bobToken } = await kickOfflineBob();
    const bobBack = await t.newClient();
    const hostHearsJoin = t.silent(alice, "player-joined");

    const answer = await t.joinAs(bobBack, gameCode, "bob", bobToken);

    expect(answer).toEqual({ success: false, message: "Removed by host" });
    expect(await hostHearsJoin).toBe(true);
    expect(playerNames(gameCode)).toEqual(["alice"]);
  });

  it("the refused socket stays bound to no room: it hears none of the room's events", async () => {
    const { gameCode, alice, bobToken } = await kickOfflineBob();
    const bobBack = await t.newClient();
    await t.joinAs(bobBack, gameCode, "bob", bobToken);
    const roundsHeard = t.silent(bobBack, "rounds-updated");

    alice.emit("set-rounds", { rounds: 15 });

    expect(await roundsHeard).toBe(true);
  });

  it("joining again by hand (no token, same name) enters as a new player", async () => {
    const { gameCode, alice, bobToken } = await kickOfflineBob();
    const bobBack = await t.newClient();
    const announced = t.once<{ username: string }>(alice, "player-joined");

    const answer = await t.joinAs(bobBack, gameCode, "bob");

    expect(answer.success).toBe(true);
    expect(answer.rejoinToken).not.toBe(bobToken);
    expect((await announced).username).toBe("bob");
    expect(playerNames(gameCode)).toEqual(["alice", "bob"]);
  });

  it("a player who left (not kicked) still comes back as a new player with their old token", async () => {
    const { gameCode, alice, bob, tokens } = await t.lobby();
    await new Promise<void>((resolve) => bob.emit("leave-room", resolve));
    const bobBack = await t.newClient();
    const announced = t.once(alice, "player-joined");

    expect((await t.joinAs(bobBack, gameCode, "bob", tokens.bob)).success).toBe(true);
    await announced;
  });
});
