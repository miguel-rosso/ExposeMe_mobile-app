import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { uploadStore } from "../middlewares/uploadStore";
import { MAX_UPLOADS_PER_ROOM } from "../middlewares/uploadAccess";

// EXP-147: lobby / ready-phase uploads can't pile up towards the room cap. Each player holds at most one unused upload
// (a new one replaces it, a new plant-photo replaces the planted one), so one member can't fill the room's photo
// budget and make every round upload fail, and the awaited owner can always upload.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-quota-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  // Rate limits out of the way: this file is about what the room holds (see uploadPlayerRate.integration.test.ts)
  process.env.UPLOAD_ROOM_RATE_MAX = "100000";
  process.env.UPLOAD_PLAYER_RATE_MAX = "100000";
  return dir;
});

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

async function createRoom(...names: string[]): Promise<Member[]> {
  const members: Member[] = [];
  let gameCode: string | null = null;
  for (const name of names) {
    const socket = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    clients.push(socket);
    await once(socket, "connect");
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

function upload(m: Member) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  return fetch(`${url}/upload`, { method: "POST", body: form, headers: authHeaders(m) });
}

async function uploadAs(m: Member): Promise<string> {
  const res = await upload(m);
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

const get = (m: Member, p: string) => fetch(`${url}${p}`, { headers: authHeaders(m) });
const onDisk = (p: string) => fs.existsSync(path.join(UPLOAD_DIR, path.basename(p)));

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startGame(members: Member[]) {
  const started = members.map((m) => once(m.socket, "game-started"));
  members[0].socket.emit("start-game");
  await Promise.all(started);
}

/** Leaves the ready phase; resolves the member that got your-turn (round 1's awaited owner). */
function readyAndGetOwner(members: Member[]): Promise<Member> {
  const turn = new Promise<Member>((resolve) => members.forEach((m) => m.socket.once("your-turn", () => resolve(m))));
  members.forEach((m) => m.socket.emit("im-ready"));
  return turn;
}

const planted = (m: Member) => roomManager.getPlayer(m.gameCode, m.name)?.plantedPhoto;

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

describe("lobby uploads (EXP-147)", () => {
  it("repeated lobby uploads keep at most two unused files per player (the newest); older ones are deleted", async () => {
    const [ann, ben] = await createRoom("ann", "ben");
    const bens = await uploadAs(ben);
    const first = await uploadAs(ann);
    const second = await uploadAs(ann);
    const third = await uploadAs(ann);
    const fourth = await uploadAs(ann);

    await until(() => !onDisk(first) && !onDisk(second));
    for (const p of [first, second]) expect((await get(ann, p)).status).toBe(404);
    for (const p of [third, fourth]) expect((await get(ann, p)).status).toBe(200);
    expect((await get(ann, bens)).status).toBe(200); // another player's upload is untouched
    expect(uploadStore.countFor(ann.gameCode)).toBe(3);
    [ann, ben].forEach((m) => m.socket.emit("leave-room"));
  });

  it("the planted photo stays valid across new uploads; a new plant-photo deletes the one it replaces", async () => {
    const [cat, dan] = await createRoom("cat", "dan");
    const a = await uploadAs(cat);
    cat.socket.emit("plant-photo", { photoUrl: a });
    await until(() => planted(cat) === a);

    const b = await uploadAs(cat); // picking another photo doesn't drop the planted one
    expect((await get(cat, a)).status).toBe(200);
    expect(onDisk(a)).toBe(true);

    cat.socket.emit("plant-photo", { photoUrl: b });
    await until(() => planted(cat) === b);
    await until(() => !onDisk(a));
    expect((await get(cat, a)).status).toBe(404);

    const c = await uploadAs(cat); // unused uploads next to the planted one
    const d = await uploadAs(cat);
    const e = await uploadAs(cat);
    await until(() => !onDisk(c));
    for (const p of [b, d, e]) expect((await get(cat, p)).status).toBe(200);
    expect(uploadStore.countFor(cat.gameCode)).toBe(3);
    [cat, dan].forEach((m) => m.socket.emit("leave-room"));
  });

  it("one player can't exhaust the room cap; the awaited owner still uploads and plays round 1", async () => {
    const members = await createRoom("eve", "fay", "gus");
    for (let i = 0; i < MAX_UPLOADS_PER_ROOM + 10; i++) expect((await upload(members[1])).status).toBe(200); // lobby
    await startGame(members);
    for (let i = 0; i < 10; i++) expect((await upload(members[1])).status).toBe(200); // ready phase
    expect(uploadStore.countFor(members[0].gameCode)).toBe(2);

    const owner = await readyAndGetOwner(members);
    const spammer = members.find((m) => m !== owner)!;
    for (let i = 0; i < 10; i++) expect((await upload(spammer)).status).toBe(200); // round 1 still awaited

    // The owner retries twice (oldest pick replaced) and sends the last
    const retried = await uploadAs(owner);
    await uploadAs(owner);
    const photo = await uploadAs(owner);
    await until(() => !onDisk(retried));
    const start = once<{ photo: string }>(owner.socket, "round-start");
    owner.socket.emit("photo-sent", { photo });
    expect((await start).photo).toBe(photo);
    expect((await get(owner, photo)).status).toBe(200);
    members.forEach((m) => m.socket.emit("leave-room"));
  });

  it("round 1's owner uploads its planted photo and its turn photo at once: both stay usable", async () => {
    const members = await createRoom("hux", "ike", "jon");
    await startGame(members);
    const lobbyPicks = new Map<Member, string>();
    for (const m of members) lobbyPicks.set(m, await uploadAs(m)); // ready phase: never superseded by turn uploads
    const owner = await readyAndGetOwner(members);
    const older = await uploadAs(owner); // an older unused turn pick, replaced by the pair below

    // Like the app: planted-photo retry after im-ready and the your-turn upload in flight together (room.round 0)
    const [plantedPhoto, turnPhoto] = await Promise.all([uploadAs(owner), uploadAs(owner)]);
    owner.socket.emit("plant-photo", { photoUrl: plantedPhoto });
    await until(() => planted(owner) === plantedPhoto);
    const start = once<{ photo: string }>(owner.socket, "round-start");
    owner.socket.emit("photo-sent", { photo: turnPhoto });
    expect((await start).photo).toBe(turnPhoto);

    for (const p of [plantedPhoto, turnPhoto, lobbyPicks.get(owner)!]) expect((await get(owner, p)).status).toBe(200);
    await until(() => !onDisk(older));
    expect(planted(owner)).toBe(plantedPhoto);
    expect(uploadStore.countFor(owner.gameCode)).toBe(2 + members.length);
    members.forEach((m) => m.socket.emit("leave-room"));
  });
});
