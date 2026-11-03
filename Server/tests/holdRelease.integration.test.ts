import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-218: whenever the photo owner goes away while holding the scores screen (leave-room or a dropped connection;
// a host's kick mid-game too, inGameKick.test.ts), the hold ends at once for everyone (hold-end + hold-resume) and the game goes on, instead of
// staying frozen until the hold budget runs out. EXP-299: the same when they rejoin on a new socket while the old one
// is still open (the new socket isn't pressing anything, so nobody would ever send hold-end).

const NAMES = ["alice", "bob", "carol"];
const RELEASE_WITHIN_MS = 1_000;
const SCORES_TIMEOUT_MS = 15_000; // waiting-photo → answering (8.5 s) → reveal (3 s) → scores
const NEXT_ROUND_TIMEOUT_MS = 8_000; // the resumed scores phase (≤ 5 s) then the next round's waiting-photo

// No resetBetweenTests: the tests run concurrently, so a reset after one would cut the others' games short
const { once, newClient, joinAs } = useTestServer();

/** A 3-player game in the first round's scores phase, with the photo owner holding it. */
async function ownerHoldingScores(photoChar: string) {
  const socks: Record<string, ClientSocket> = {};
  const tokens: Record<string, string> = {};
  socks.alice = await newClient();
  const created = await joinAs(socks.alice, null, "alice");
  const gameCode = created.room!.gameCode;
  tokens.alice = created.rejoinToken!;
  for (const n of NAMES.slice(1)) {
    socks[n] = await newClient();
    tokens[n] = (await joinAs(socks[n], gameCode, n)).rejoinToken!;
  }
  const started = NAMES.map((n) => once(socks[n], "game-started"));
  socks.alice.emit("start-game");
  await Promise.all(started);
  const turn = new Promise<string>((resolve) => { for (const n of NAMES) socks[n].once("your-turn", () => resolve(n)); });
  NAMES.forEach((n) => socks[n].emit("im-ready"));
  const owner = await turn;

  const photo = "/temp/" + photoChar.repeat(32) + ".jpg";
  registerTurnUpload(gameCode, owner, photo, 1);
  const scores = NAMES.map((n) => once(socks[n], "round-scores", SCORES_TIMEOUT_MS));
  socks[owner].emit("photo-sent", { photo });
  await Promise.all(scores);

  const holding = NAMES.map((n) => once(socks[n], "hold-start"));
  socks[owner].emit("hold-start");
  await Promise.all(holding);
  return { socks, tokens, gameCode, owner, others: NAMES.filter((n) => n !== owner) };
}

/** Every remaining player gets hold-end and hold-resume (scores) quickly, then the next round starts. */
async function expectReleasedAndContinues(socks: Record<string, ClientSocket>, others: string[], goAway: () => void) {
  const ends = others.map((n) => once(socks[n], "hold-end", RELEASE_WITHIN_MS));
  const resumes = others.map((n) => once<{ phase: string; duration: number }>(socks[n], "hold-resume", RELEASE_WITHIN_MS));
  goAway();
  await Promise.all([...ends, ...resumes]);
  for (const resume of await Promise.all(resumes)) expect(resume.phase).toBe("scores");
  await Promise.all(others.map((n) => once(socks[n], "waiting-photo", NEXT_ROUND_TIMEOUT_MS)));
}

// One room each, run side by side: reaching the scores phase takes ~12 s of real game time
describe.concurrent("the photo owner going away releases their hold (EXP-218, EXP-299)", () => {
  it("when they leave the room", async () => {
    const { socks, owner, others } = await ownerHoldingScores("b");
    await expectReleasedAndContinues(socks, others, () => socks[owner].emit("leave-room"));
  }, 30_000);

  it("when their connection drops", async () => {
    const { socks, owner, others } = await ownerHoldingScores("d");
    await expectReleasedAndContinues(socks, others, () => socks[owner].disconnect());
  }, 30_000);

  it("when they rejoin on a new socket while the old one is still open", async () => {
    const { socks, tokens, gameCode, owner, others } = await ownerHoldingScores("e");
    const fresh = await newClient();
    const snapshot = once<{ phase: string; held: boolean }>(fresh, "game-state", RELEASE_WITHIN_MS);
    await expectReleasedAndContinues(socks, others, () => {
      fresh.emit("join-create-game", { gameCode, username: owner, rejoinToken: tokens[owner] });
    });
    expect(await snapshot).toMatchObject({ phase: "scores", held: false });
  }, 30_000);
});
