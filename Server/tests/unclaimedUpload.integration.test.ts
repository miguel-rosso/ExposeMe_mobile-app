import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";

// EXP-130: an upload that arrives once it can no longer be used (a turn upload retried after background that only
// lands after game-over, back in the lobby) is stored as a planted-kind upload; if no plant-photo claims it within
// UPLOAD_PLANT_CLAIM_MS it is deleted instead of staying until the 30-min TTL. Lobby planting (upload + plant-photo)
// and re-planting keep working.

const CLAIM_MS = 600;

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-unclaimed-upload-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_PLANT_CLAIM_MS = "600";
  delete process.env.UPLOAD_RATE_WINDOW_MS;
  return dir;
});

import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { UPLOAD_PLANT_CLAIM_MS } from "../middlewares/uploadStore";

interface Member { name: string; socket: ClientSocket; token: string; gameCode: string }

let url: string;
let jpeg: Buffer;
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

const authHeaders = (m: Member) => ({ Authorization: `Bearer ${m.token}`, "X-Game-Code": m.gameCode });

async function uploadAs(m: Member): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  const res = await fetch(`${url}/upload`, { method: "POST", body: form, headers: authHeaders(m) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

const getAs = (m: Member, photo: string) => fetch(`${url}${photo}`, { headers: authHeaders(m) });
const onDisk = (photo: string) => fs.existsSync(path.join(UPLOAD_DIR, path.basename(photo)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough for an unclaimed upload's claim window to run out. */
const pastClaimWindow = () => sleep(CLAIM_MS + 400);

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met");
    await sleep(20);
  }
}

/** plant-photo, resolved once the server has it as the player's planted photo. */
async function plant(m: Member, photo: string) {
  m.socket.emit("plant-photo", { photoUrl: photo });
  await until(() => roomManager.getPlayer(m.gameCode, m.name)?.plantedPhoto === photo);
}

/**
 * Starts a game in a new room of three and ends it while round 1's photo is awaited (the other two leave for good).
 * Resolves the awaited photo owner, the one player left, back in the lobby.
 */
async function ownerAfterGameOver(...names: string[]): Promise<Member> {
  const members = await createRoom(...names);
  const started = members.map((m) => once(m.socket, "game-started"));
  members[0].socket.emit("start-game");
  await Promise.all(started);
  const turn = new Promise<Member>((resolve) => members.forEach((m) => m.socket.once("your-turn", () => resolve(m))));
  members.forEach((m) => m.socket.emit("im-ready"));
  const owner = await turn;
  const over = once(owner.socket, "game-over");
  members.filter((m) => m !== owner).forEach((m) => m.socket.emit("leave-room"));
  await over;
  return owner;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("uploads nobody plants are not kept", () => {
  it("uses the configured claim window", () => {
    expect(UPLOAD_PLANT_CLAIM_MS).toBe(CLAIM_MS);
  });

  it("an upload that lands after game-over and is never planted is deleted after the claim window", async () => {
    // The owner's turn upload is still being retried when the game ends...
    const owner = await ownerAfterGameOver("ada", "bea", "cyd");

    // ...and only arrives now, back in the lobby: nobody will send plant-photo / photo-sent for it
    const late = await uploadAs(owner);
    expect(onDisk(late)).toBe(true);
    await until(() => !onDisk(late), CLAIM_MS + 3_000);
    expect((await getAs(owner, late)).status).toBe(404);
    owner.socket.emit("leave-room");
  });

  it("lobby planting keeps the planted photo past the claim window; a re-plant replaces it and is kept too", async () => {
    const [host, guest] = await createRoom("eli", "fay");
    const first = await uploadAs(guest);
    await plant(guest, first);
    await pastClaimWindow();
    expect(onDisk(first)).toBe(true);
    expect((await getAs(host, first)).status).toBe(200);

    const second = await uploadAs(guest);
    await plant(guest, second);
    await until(() => !onDisk(first));
    await pastClaimWindow();
    expect(onDisk(second)).toBe(true);
    expect(roomManager.getPlayer(guest.gameCode, guest.name)?.plantedPhoto).toBe(second);
    [host, guest].forEach((m) => m.socket.emit("leave-room"));
  });

  it("a planted photo sent after game-over for the next game (play again) is kept", async () => {
    const solo = await ownerAfterGameOver("gus", "hob", "ike");
    const next = await uploadAs(solo);
    await plant(solo, next);
    await pastClaimWindow();
    expect(onDisk(next)).toBe(true);
    solo.socket.emit("leave-room");
  });
});
