import fs from "fs";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-111: photo-sent only takes the photo uploaded for the turn being awaited, like photo-unavailable is bound to
// the current request. An own upload from an earlier round (already shown) or a planted photo (lobby pick or
// plant-photo) is ignored; the current round's own turn upload starts the round. Real uploads (POST /upload), so the
// records carry what the server stored for them.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-photo-sent-turn-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  delete process.env.UPLOAD_RATE_WINDOW_MS;
  return dir;
});

const QUIET_MS = 500;
// Round 1 answering (8 s) + reveal (3 s) + scores (5 s) before round 2's photo request, plus margin
const NEXT_TURN_TIMEOUT_MS = 22_000;

interface Member { name: string; socket: ClientSocket; token: string; gameCode: string }
interface YourTurn { round: number; attempt: number }

let url: string;
let jpeg: Buffer;
const clients: ClientSocket[] = [];
let randomSpy: { mockRestore(): void } | undefined;

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Resolves true if `event` is NOT received within `ms`. */
function silent(socket: ClientSocket, event: string, ms = QUIET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

/** Creates a room with `names` (first is host); returns each member with its rejoin token. */
async function createRoom(...names: string[]): Promise<Member[]> {
  const members: Member[] = [];
  let gameCode: string | null = null;
  for (const name of names) {
    const socket = await newClient();
    const res = once<{ success: boolean; room: { gameCode: string }; rejoinToken: string }>(socket, "room-of-game");
    socket.emit("join-create-game", { gameCode, username: name });
    const r = await res;
    expect(r.success).toBe(true);
    gameCode = r.room.gameCode;
    members.push({ name, socket, token: r.rejoinToken, gameCode });
  }
  return members;
}

async function uploadAs(m: Member): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  const res = await fetch(`${url}/upload`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${m.token}`, "X-Game-Code": m.gameCode },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

/**
 * Starts the game; the first connected player (the host) is picked as owner of every round (Math.random → 0, which
 * also keeps round 1 a normal round when someone planted a photo). Resolves the host's first your-turn.
 */
async function startWithHostAsOwner(members: Member[]): Promise<YourTurn> {
  randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  const started = members.map((m) => once(m.socket, "game-started"));
  members[0].socket.emit("start-game");
  await Promise.all(started);
  const turn = once<YourTurn>(members[0].socket, "your-turn");
  members.forEach((m) => m.socket.emit("im-ready"));
  return turn;
}

/** `photo` sent by `sender` doesn't start the round. */
async function expectIgnored(sender: Member, watcher: Member, photo: string) {
  const quiet = silent(watcher.socket, "round-start");
  sender.socket.emit("photo-sent", { photo });
  expect(await quiet).toBe(true);
}

/** `photo` sent by `sender` starts round `round` with it. */
async function expectAccepted(sender: Member, watcher: Member, photo: string, round: number) {
  const start = once<{ photo: string; round: number }>(watcher.socket, "round-start");
  sender.socket.emit("photo-sent", { photo });
  expect(await start).toMatchObject({ photo, round });
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  randomSpy?.mockRestore();
  randomSpy = undefined;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("photo-sent takes only the upload for the awaited turn", () => {
  it("an own photo already shown in an earlier round is not accepted again", async () => {
    const [ann, ben] = await createRoom("ann", "ben");
    await startWithHostAsOwner([ann, ben]);
    const shown = await uploadAs(ann);
    await expectAccepted(ann, ben, shown, 1);

    await once<YourTurn>(ann.socket, "your-turn", NEXT_TURN_TIMEOUT_MS); // ann owns round 2 too
    await expectIgnored(ann, ben, shown);

    await expectAccepted(ann, ben, await uploadAs(ann), 2);
    for (const m of [ann, ben]) m.socket.emit("leave-room");
  }, 30_000);

  it("a planted photo (lobby or the owner's planted retry while their turn is awaited) is not a turn photo", async () => {
    const [ann, ben, cat] = await createRoom("ann", "ben", "cat");
    const lobbyPlanted = await uploadAs(ann);
    ann.socket.emit("plant-photo", { photoUrl: lobbyPlanted });
    await vi.waitFor(() => expect(roomManager.getRoom(ann.gameCode)?.players[0].plantedPhoto).toBe(lobbyPlanted));

    await startWithHostAsOwner([ann, ben, cat]);
    await expectIgnored(ann, ben, lobbyPlanted);

    // Round 1's photo is still awaited, so planted photos are still taken: the owner's own upload, planted
    const plantedRetry = await uploadAs(ann);
    ann.socket.emit("plant-photo", { photoUrl: plantedRetry });
    await vi.waitFor(() => expect(roomManager.getRoom(ann.gameCode)?.players[0].plantedPhoto).toBe(plantedRetry));
    await expectIgnored(ann, ben, plantedRetry);

    await expectAccepted(ann, ben, await uploadAs(ann), 1);
    for (const m of [ann, ben, cat]) m.socket.emit("leave-room");
  });

  it("an owner re-picked for the same round can't send the previous owner's upload", async () => {
    const [ann, ben] = await createRoom("ann", "ben");
    const turn = await startWithHostAsOwner([ann, ben]);
    const annPhoto = await uploadAs(ann);

    const benTurn = once<YourTurn>(ben.socket, "your-turn");
    ann.socket.emit("photo-unavailable", turn); // the next attempt of round 1 goes to ben
    expect(await benTurn).toMatchObject({ round: 1 });

    await expectIgnored(ben, ann, annPhoto);
    await expectIgnored(ann, ben, annPhoto); // no longer the owner
    await expectAccepted(ben, ann, await uploadAs(ben), 1);
    for (const m of [ann, ben]) m.socket.emit("leave-room");
  });
});
