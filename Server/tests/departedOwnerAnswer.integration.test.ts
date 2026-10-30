import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-301 / DEC-038: the photo owner who leaves while answering stays the round's answer until its scores, so the
// players who guess them right score (also with a pick sent after they left); a non-owner who leaves during the round
// is still not the answer (a pick on them scores nothing).

const PHOTO = "/temp/" + "d".repeat(32) + ".jpg";
const NAMES = ["alice", "bob", "carol", "dave", "erin"];

const { once, newClient, joinAs } = useTestServer();

/** `sock` saw `username` leave the room (so the server handled the leave before anything `sock` sends next) */
function leftSeenBy(sock: ClientSocket, username: string): Promise<void> {
  return new Promise((resolve) => {
    const onLeft = (name: string) => { if (name === username) { sock.off("player-left", onLeft); resolve(); } };
    sock.on("player-left", onLeft);
  });
}

describe("players leaving while answering (EXP-301, DEC-038)", () => {
  it("scores right guesses of the owner who left, and no point for a non-owner who left", async () => {
    const socks: Record<string, ClientSocket> = {};
    socks.alice = await newClient();
    const gameCode = (await joinAs(socks.alice, null, "alice")).room!.gameCode;
    for (const n of NAMES.slice(1)) {
      socks[n] = await newClient();
      await joinAs(socks[n], gameCode, n);
    }
    const started = NAMES.map((n) => once(socks[n], "game-started"));
    socks.alice.emit("start-game");
    await Promise.all(started);
    const turn = new Promise<string>((resolve) => { for (const n of NAMES) socks[n].once("your-turn", () => resolve(n)); });
    NAMES.forEach((n) => socks[n].emit("im-ready"));
    const owner = await turn;
    const [early, late, leaverPicker, leaver] = NAMES.filter((n) => n !== owner);

    const starts = NAMES.map((n) => once(socks[n], "round-start"));
    registerTurnUpload(gameCode, owner, PHOTO, 1);
    socks[owner].emit("photo-sent", { photo: PHOTO });
    await Promise.all(starts);

    // Right before the owner leaves; then a pick on a player who is about to leave
    socks[early].emit("submit-answer", { guess: owner });
    socks[leaverPicker].emit("submit-answer", { guess: early });
    const ownerLeft = leftSeenBy(socks[late], owner);
    socks[owner].emit("leave-room");
    await ownerLeft;
    // After the owner left: still the answer
    socks[late].emit("submit-answer", { guess: owner });
    const leaverLeft = leftSeenBy(socks[leaverPicker], leaver);
    socks[leaver].emit("leave-room");
    await leaverLeft;
    // After a non-owner left: a pick on them replaces the previous one and scores nothing
    socks[leaverPicker].emit("submit-answer", { guess: leaver });

    const reveal = await once<{ correctAnswer: string; yourGuess: string }>(socks[early], "round-reveal", 15_000);
    expect(reveal).toMatchObject({ correctAnswer: owner, yourGuess: owner });
    const { scores } = await once<{ scores: { username: string; lastGuess: string; points: number }[] }>(socks[early], "round-scores", 15_000);
    const row = (n: string) => scores.find((s) => s.username === n)!;
    expect(row(early)).toMatchObject({ lastGuess: owner, points: 1 });
    expect(row(late)).toMatchObject({ lastGuess: owner, points: 1 });
    expect(row(leaverPicker)).toMatchObject({ lastGuess: leaver, points: 0 });
    [early, late, leaverPicker].forEach((n) => socks[n].emit("leave-room"));
  }, 25_000);
});
