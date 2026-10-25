import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { registerUpload } from "./helpers";

// EXP-148: the app sends submit-answer on every tap, so the server rate-limits it per socket (token bucket, excess
// dropped silently) and the legacy correct-answer / incorrect-answer aliases are gone.

const PHOTO = "/temp/" + "c".repeat(32) + ".jpg";
const NAMES = ["alice", "bob", "carol", "dave"];

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

async function joinAs(sock: ClientSocket, gameCode: string | null, username: string) {
  const res = once<{ success: boolean; room?: { gameCode: string } }>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username });
  return res;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
});

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
    registerUpload(gameCode, owner, PHOTO);
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
