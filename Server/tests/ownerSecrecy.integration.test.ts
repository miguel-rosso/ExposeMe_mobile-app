import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { registerUpload } from "./helpers";
import { ANSWER_GRACE } from "../managers/GameEngine";

// EXP-128 / EXP-252: real server + real clients, every event each socket receives is recorded. Until round-reveal,
// nobody, the owner included, receives the photo owner's identity (no `owner` / `isOwner` key, the owner's name
// nowhere but in the player lists), also in the game-state snapshots of a rejoin (new socket) or a re-sent join (same
// socket). The owner plays like everyone: their vote is recorded and scored.

const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
const NAMES = ["alice", "bob", "carol"];

interface Received { who: string; sock: string; ev: string; args: unknown[]; t: number }
interface RoomOfGame { success: boolean; rejoinToken?: string; room?: { gameCode: string } }

let url: string;
const clients: ClientSocket[] = [];
const received: Received[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function newClient(who: string): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  c.onAny((ev: string, ...args: unknown[]) => received.push({ who, sock: c.id ?? "", ev, args, t: Date.now() }));
  await once(c, "connect");
  return c;
}

async function joinAs(sock: ClientSocket, gameCode: string | null, username: string, rejoinToken?: string): Promise<RoomOfGame> {
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken ? { rejoinToken } : {}) });
  return res;
}

/** Owner identity in one received payload: `owner` / `isOwner` keys, or the name outside player entries. */
function ownerLeaks(r: Received, ownerName: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") { if (v === ownerName) out.push(`${r.who} ${r.ev} ${path}: owner name`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}.${i}`)); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if ("owner" in o) out.push(`${r.who} ${r.ev} ${path}.owner: owner key`);
    if ("isOwner" in o) out.push(`${r.who} ${r.ev} ${path}.isOwner: owner flag`);
    if ("username" in o) return; // a player entry: every player is listed the same way
    for (const [k, x] of Object.entries(o)) if (k !== "waitingFor") walk(x, `${path}.${k}`);
  };
  r.args.forEach((x, i) => walk(x, String(i)));
  return out;
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

describe("photo owner secrecy over the socket (EXP-128, EXP-252)", () => {
  it("nobody, the owner included, learns the owner before round-reveal, rejoin snapshots included; the owner's vote counts", async () => {
    const socks: Record<string, ClientSocket> = {};
    const tokens: Record<string, string> = {};
    socks.alice = await newClient("alice");
    const created = await joinAs(socks.alice, null, "alice");
    const gameCode = created.room!.gameCode;
    tokens.alice = created.rejoinToken!;
    for (const n of NAMES.slice(1)) {
      socks[n] = await newClient(n);
      tokens[n] = (await joinAs(socks[n], gameCode, n)).rejoinToken!;
    }

    const started = NAMES.map((n) => once(socks[n], "game-started"));
    socks.alice.emit("start-game");
    await Promise.all(started);
    const turn = new Promise<string>((resolve) => {
      for (const n of NAMES) socks[n].once("your-turn", () => resolve(n));
    });
    NAMES.forEach((n) => socks[n].emit("im-ready"));
    const owner = await turn;
    const others = NAMES.filter((n) => n !== owner);

    const starts = NAMES.map((n) => once<Record<string, unknown>>(socks[n], "round-start"));
    registerUpload(gameCode, owner, PHOTO);
    socks[owner].emit("photo-sent", { photo: PHOTO });
    const startData = await Promise.all(starts);
    startData.forEach((data) => expect(data).toEqual({ photo: PHOTO, round: 1, duration: 8_000 - ANSWER_GRACE }));

    // The owner recognises their photo and votes for themselves, like any player could
    socks[owner].emit("submit-answer", { guess: owner });

    // A non-owner drops and rejoins on a new socket mid-answering
    const [away, stay] = others;
    socks[away].disconnect();
    socks[away] = await newClient(away);
    const awaySnap = once<Record<string, unknown>>(socks[away], "game-state");
    expect((await joinAs(socks[away], gameCode, away, tokens[away])).success).toBe(true);
    expect(await awaySnap).toMatchObject({ phase: "answering", photo: PHOTO, correctAnswer: null });

    // The other non-owner re-sends its join on the same socket (lobby → game screen hand-over)
    const staySnap = once<Record<string, unknown>>(socks[stay], "game-state");
    await joinAs(socks[stay], gameCode, stay, tokens[stay]);
    expect(await staySnap).toMatchObject({ phase: "answering", correctAnswer: null });

    // The owner rejoins on a new socket: their snapshot is the same as anyone's (not told it is their photo)
    socks[owner].disconnect();
    socks[owner] = await newClient(owner);
    const ownerSnap = once<Record<string, unknown>>(socks[owner], "game-state");
    expect((await joinAs(socks[owner], gameCode, owner, tokens[owner])).success).toBe(true);
    expect(await ownerSnap).toMatchObject({ phase: "answering", photo: PHOTO, correctAnswer: null });

    // Reveal: everyone learns the answer as before
    const reveals = NAMES.map((n) => once<{ correctAnswer: string }>(socks[n], "round-reveal", 10_000));
    const revealed = await Promise.all(reveals);
    revealed.forEach((r) => expect(r.correctAnswer).toBe(owner));
    const revealAt = Math.min(...received.filter((r) => r.ev === "round-reveal").map((r) => r.t));
    // A vote once the answer is public is ignored, the owner's too; their answer while answering was scored
    socks[owner].emit("submit-answer", { guess: others[0] });
    const scores = await once<{ scores: { username: string; points: number; lastGuess: string; lastAnswerCorrect: boolean }[] }>(socks[stay], "round-scores", 6_000);
    expect(scores.scores.find((s) => s.username === owner)).toMatchObject({ points: 1, lastGuess: owner, lastAnswerCorrect: true });

    // Everything anyone (the owner included) received before the reveal is free of the owner's identity
    const before = received.filter((r) => r.t < revealAt && r.ev !== "round-reveal");
    expect(before.filter((r) => r.ev === "round-start")).toHaveLength(NAMES.length);
    expect(before.filter((r) => r.ev === "game-state")).toHaveLength(3);
    expect(before.flatMap((r) => ownerLeaks(r, owner))).toEqual([]);

    for (const n of NAMES) socks[n].emit("leave-room");
  }, 25_000);
});
