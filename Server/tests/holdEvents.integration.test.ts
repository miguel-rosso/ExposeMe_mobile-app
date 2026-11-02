import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { MAX_HOLDS_PER_ROUND } from "../managers/GameEngine";
import type { GameStateSnapshot } from "../models/interfaces";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-214: pins what each client receives, and in which order, when the photo owner holds and releases the scores
// screen and when a pause ends a hold, so the hold events can be emitted from a single place without changing what
// goes on the wire.

const SCORES_TIMEOUT_MS = 15_000; // waiting-photo → answering (8.5 s) → reveal (3 s) → scores
const QUIET_MS = 300;

const harness = useTestServer({ quietMs: QUIET_MS });
const { once, silent, newClient, joinAs, startGame } = harness;

const quiet = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

/** Names of every event `socket` receives from now on, in order. */
function record(socket: ClientSocket): string[] {
  const received: string[] = [];
  socket.onAny((event: string) => received.push(event));
  return received;
}

/** Payloads of every `event` that `socket` receives from now on, in order. */
function recordPayloads(socket: ClientSocket, event: string): unknown[] {
  const payloads: unknown[] = [];
  socket.on(event, (data: unknown) => payloads.push(data));
  return payloads;
}

/** A game of `names` in the first round's scores phase (nobody holding yet). */
async function inScores(names: string[], photoChar: string) {
  const socks: Record<string, ClientSocket> = {};
  socks[names[0]] = await newClient();
  const gameCode = (await joinAs(socks[names[0]], null, names[0])).room!.gameCode;
  for (const n of names.slice(1)) {
    socks[n] = await newClient();
    expect((await joinAs(socks[n], gameCode, n)).success).toBe(true);
  }
  await startGame(socks[names[0]], names.map((n) => socks[n]));
  const turn = new Promise<string>((resolve) => { for (const n of names) socks[n].once("your-turn", () => resolve(n)); });
  names.forEach((n) => socks[n].emit("im-ready"));
  const owner = await turn;

  const photo = "/temp/" + photoChar.repeat(32) + ".jpg";
  registerTurnUpload(gameCode, owner, photo, 1);
  const scores = names.map((n) => once(socks[n], "round-scores", SCORES_TIMEOUT_MS));
  socks[owner].emit("photo-sent", { photo });
  await Promise.all(scores);
  return { gameCode, socks, owner, others: names.filter((n) => n !== owner) };
}

// One room each, run side by side: reaching the scores phase takes ~12 s of real game time
describe.concurrent("hold events on the wire (EXP-214)", () => {
  it("hold-start goes to everyone once per accepted hold; a release sends hold-resume, then hold-end", async () => {
    const names = ["alice", "bob", "carol"];
    const { socks, owner, others } = await inScores(names, "1");
    const received = Object.fromEntries(names.map((n) => [n, record(socks[n])]));

    // A non-owner's hold-start is refused: nobody hears anything
    socks[others[0]].emit("hold-start");
    expect(await silent(socks[owner], "hold-start")).toBe(true);

    // The owner's hold: hold-start to the whole room (the owner included); a second one while held is refused
    const holding = names.map((n) => once(socks[n], "hold-start"));
    socks[owner].emit("hold-start");
    await Promise.all(holding);
    socks[owner].emit("hold-start");
    await quiet();

    const released = names.map((n) => once(socks[n], "hold-end"));
    socks[owner].emit("hold-end");
    await Promise.all(released);
    await quiet();
    for (const n of names) expect(received[n], n).toEqual(["hold-start", "hold-resume", "hold-end"]);
  }, 30_000);

  it("a pause during a hold sends hold-end, then game-paused, and no hold-resume", async () => {
    const { socks, owner, others } = await inScores(["dave", "erin"], "2");
    const holding = once(socks[owner], "hold-start");
    socks[owner].emit("hold-start");
    await holding;

    const received = record(socks[owner]);
    const paused = once(socks[owner], "game-paused");
    socks[others[0]].disconnect();
    await paused;
    await quiet();
    expect(received).toEqual(["hold-end", "game-paused"]);
  }, 30_000);

  // EXP-176: the app greys its hold button out from what the server says, instead of counting holds itself
  it("each release sends everyone exactly one hold-end with the holds left, down to 0; game-state says the same", async () => {
    const names = ["frank", "grace"];
    const { gameCode, socks, owner } = await inScores(names, "3");
    const holdEnds = Object.fromEntries(names.map((n) => [n, recordPayloads(socks[n], "hold-end")]));

    for (let hold = 0; hold < MAX_HOLDS_PER_ROUND; hold++) {
      const holding = once(socks[owner], "hold-start");
      socks[owner].emit("hold-start");
      await holding;
      const released = names.map((n) => once(socks[n], "hold-end"));
      socks[owner].emit("hold-end");
      await Promise.all(released);
    }
    await quiet();
    for (const n of names) expect(holdEnds[n], n).toEqual([{ holdsLeft: 2 }, { holdsLeft: 1 }, { holdsLeft: 0 }]);

    // The owner's screen asks again (same socket, same room): the snapshot says none are left, and none is accepted
    const snapshot = once<GameStateSnapshot>(socks[owner], "game-state");
    socks[owner].emit("join-create-game", { gameCode, username: owner });
    expect(await snapshot).toMatchObject({ phase: "scores", holdsLeft: 0 });
    socks[owner].emit("hold-start");
    expect(await silent(socks[owner], "hold-start")).toBe(true);
  }, 30_000);
});
