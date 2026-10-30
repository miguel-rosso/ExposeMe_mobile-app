import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-148: the app sends submit-answer on every tap, so the server rate-limits it per socket (token bucket, excess
// dropped silently) and the legacy correct-answer / incorrect-answer aliases are gone.

const PHOTO = "/temp/" + "c".repeat(32) + ".jpg";
const NAMES = ["alice", "bob", "carol", "dave"];

const { once, newClient, joinAs } = useTestServer();

describe("submit-answer over the socket (EXP-148)", () => {
  it("drops a burst beyond the per-socket limit, recovers after a pause, and ignores the legacy aliases", async () => {
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
    const [burst, legacy, recovers] = NAMES.filter((n) => n !== owner);

    const starts = NAMES.map((n) => once(socks[n], "round-start"));
    registerTurnUpload(gameCode, owner, PHOTO, 1);
    socks[owner].emit("photo-sent", { photo: PHOTO });
    await Promise.all(starts);

    // 10 picks use up the burst; the 5 right after it (the right answer) are dropped
    for (let i = 0; i < 10; i++) socks[burst].emit("submit-answer", { guess: legacy });
    for (let i = 0; i < 5; i++) socks[burst].emit("submit-answer", { guess: owner });
    // Legacy aliases no longer record anything
    socks[legacy].emit("correct-answer", { guess: owner });
    socks[legacy].emit("incorrect-answer", { guess: owner });
    // A burst, then a pause: the bucket refills and the next pick counts
    for (let i = 0; i < 12; i++) socks[recovers].emit("submit-answer", { guess: burst });
    await new Promise((r) => setTimeout(r, 1_000));
    socks[recovers].emit("submit-answer", { guess: owner });

    const { scores } = await once<{ scores: { username: string; lastGuess: string; points: number }[] }>(socks[owner], "round-scores", 15_000);
    const row = (n: string) => scores.find((s) => s.username === n)!;
    expect(row(burst)).toMatchObject({ lastGuess: legacy, points: 0 });
    expect(row(legacy)).toMatchObject({ lastGuess: "", points: 0 });
    expect(row(recovers)).toMatchObject({ lastGuess: owner, points: 1 });
    NAMES.forEach((n) => socks[n].emit("leave-room"));
  }, 25_000);
});
