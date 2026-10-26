import fs from "fs";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { UPLOAD_LOBBY_PER_IP_MAX, UPLOAD_STORED_MAX, uploadStore } from "../middlewares/uploadStore";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { limit } from "../controllers/sanitizeImage";

// EXP-195: the per-room cap (100 photos) doesn't bound the disk when many rooms fill up. Lobby photos (lobby picks and
// planted photos) are shed first: none is stored while the server holds UPLOAD_STORED_MAX photos (503, scope
// "storage") nor past UPLOAD_LOBBY_PER_IP_MAX per uploader IP (429, scope "lobby-ip"), with Retry-After = when the
// oldest counted photo expires. The awaited owner's turn photo of a started game is never refused by these limits.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-stored-cap-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  process.env.UPLOAD_STORED_MAX = "4";
  process.env.UPLOAD_LOBBY_PER_IP_MAX = "2";
  process.env.UPLOAD_ROOM_RATE_MAX = "100000";
  process.env.UPLOAD_PLAYER_RATE_MAX = "100000";
  // req.ip from X-Forwarded-For, so each member can upload from its own IP
  process.env.TRUST_PROXY = "1";
  return dir;
});

interface Member { name: string; socket: ClientSocket; token: string; gameCode: string; ip: string }

let url: string;
let jpeg: Buffer;
const clients: ClientSocket[] = [];
const roomCodes = new Set<string>();
const TTL_S = UPLOAD_TTL_MS / 1000;

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** A new room with one member per [name, ip]; the first creates it. */
async function createRoom(...people: Array<[name: string, ip: string]>): Promise<Member[]> {
  const members: Member[] = [];
  let gameCode: string | null = null;
  for (const [name, ip] of people) {
    const socket = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    clients.push(socket);
    await once(socket, "connect");
    const res = once<{ success: boolean; room: { gameCode: string }; rejoinToken: string }>(socket, "room-of-game");
    socket.emit("join-create-game", { gameCode, username: name });
    const r = await res;
    expect(r.success).toBe(true);
    gameCode = r.room.gameCode;
    roomCodes.add(gameCode);
    members.push({ name, socket, token: r.rejoinToken, gameCode, ip });
  }
  return members;
}

function upload(m: Member) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  return fetch(`${url}/upload`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${m.token}`, "X-Game-Code": m.gameCode, "X-Forwarded-For": m.ip },
  });
}

async function expectStored(m: Member) {
  const res = await upload(m);
  expect(res.status).toBe(200);
}

/** Refused with `status`/`scope`, and a Retry-After that is the oldest counted photo's expiry (stored just now). */
async function expectRefused(res: Response, status: number, scope: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ scope });
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(TTL_S - 60);
  expect(retryAfter).toBeLessThanOrEqual(TTL_S);
}

const filesOnDisk = () => fs.readdirSync(UPLOAD_DIR).length;

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Starts the game and leaves the ready phase; resolves the member that got your-turn (round 1's awaited owner). */
async function startAndGetOwner(members: Member[]): Promise<Member> {
  const started = members.map((m) => once(m.socket, "game-started"));
  members[0].socket.emit("start-game");
  await Promise.all(started);
  const turn = new Promise<Member>((resolve) => members.forEach((m) => m.socket.once("your-turn", () => resolve(m))));
  members.forEach((m) => m.socket.emit("im-ready"));
  return turn;
}

/** Fills the server-wide budget with lobby photos from two IPs, each at its own per-IP cap. */
async function fillWithLobbyPhotos() {
  const [ann] = await createRoom(["ann", "198.51.100.1"]);
  const [ben] = await createRoom(["ben", "198.51.100.2"]);
  for (const m of [ann, ann, ben, ben]) await expectStored(m);
  expect(uploadStore.size).toBe(UPLOAD_STORED_MAX);
  return { ann, ben };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a33" } }).jpeg().toBuffer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const gameCode of roomCodes) uploadStore.releaseRoom(gameCode);
  await until(() => filesOnDisk() === 0);
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

describe("server-wide storage limits (EXP-195)", () => {
  it("are read from UPLOAD_STORED_MAX and UPLOAD_LOBBY_PER_IP_MAX", () => {
    expect(UPLOAD_STORED_MAX).toBe(4);
    expect(UPLOAD_LOBBY_PER_IP_MAX).toBe(2);
  });

  it("a full server refuses lobby photos from any room and IP (503 storage); freeing photos lets them in", async () => {
    const { ann } = await fillWithLobbyPhotos();
    const [cat] = await createRoom(["cat", "198.51.100.3"]);
    await expectRefused(await upload(cat), 503, "storage");
    expect(uploadStore.size).toBe(UPLOAD_STORED_MAX);
    expect(filesOnDisk()).toBe(UPLOAD_STORED_MAX);

    uploadStore.releaseRoom(ann.gameCode); // game over in ann's room
    await expectStored(cat);
  });

  it("one IP can't take more than UPLOAD_LOBBY_PER_IP_MAX lobby photos, whatever rooms it creates (429 lobby-ip)", async () => {
    const [dan] = await createRoom(["dan", "198.51.100.4"]);
    const [dan2] = await createRoom(["dan2", "198.51.100.4"]);
    await expectStored(dan);
    await expectStored(dan2);
    const [dan3] = await createRoom(["dan3", "198.51.100.4"]);
    await expectRefused(await upload(dan3), 429, "lobby-ip");
    const [eve] = await createRoom(["eve", "198.51.100.5"]); // another IP still has its own budget
    await expectStored(eve);

    uploadStore.releaseRoom(dan.gameCode);
    await expectStored(dan3);
  });

  it("IPv6: the per-IP lobby cap counts a whole /48 (rotating /64s doesn't help); another /48 has its own", async () => {
    const [a] = await createRoom(["v6a", "2001:db8:aaaa:1::1"]);
    const [b] = await createRoom(["v6b", "2001:db8:aaaa:2::1"]);
    const [c] = await createRoom(["v6c", "2001:db8:aaaa:ffff::9"]);
    await expectStored(a);
    await expectStored(b);
    await expectRefused(await upload(c), 429, "lobby-ip");
    const [d] = await createRoom(["v6d", "2001:db8:bbbb:1::1"]);
    await expectStored(d);
  });

  it("the awaited owner's turn photo of a started game is stored even with the server full and its IP over its cap", async () => {
    const ip = "198.51.100.1"; // ann's IP, which fillWithLobbyPhotos takes to its per-IP cap
    const players = await createRoom(["fay", ip], ["gus", ip]);
    await fillWithLobbyPhotos();
    const owner = await startAndGetOwner(players);
    const other = players.find((p) => p !== owner)!;
    await expectRefused(await upload(other), 503, "storage"); // a planted photo in the ready phase is still a lobby photo
    await expectStored(owner);
    expect(uploadStore.size).toBe(UPLOAD_STORED_MAX + 1);
  });

  it("lobby photos processed together near the cap: only those that still fit are stored", async () => {
    const [hal] = await createRoom(["hal", "198.51.100.6"]);
    const [ivy] = await createRoom(["ivy", "198.51.100.7"]);
    const [jon] = await createRoom(["jon", "198.51.100.8"]);
    const [kim] = await createRoom(["kim", "198.51.100.9"]);
    for (const m of [hal, hal, ivy]) await expectStored(m);
    // Both pass the check before processing (3 stored < 4) while the queue is held; only one fits when storing
    let releaseQueue!: () => void;
    const held = limit(() => new Promise<void>((r) => { releaseQueue = r; }));
    const pending = [upload(jon), upload(kim)];
    await until(() => limit.stats().queued === 2);
    releaseQueue();
    await held;
    const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 503]);
    expect(uploadStore.size).toBe(UPLOAD_STORED_MAX);
    expect(filesOnDisk()).toBe(UPLOAD_STORED_MAX);
  });
});
