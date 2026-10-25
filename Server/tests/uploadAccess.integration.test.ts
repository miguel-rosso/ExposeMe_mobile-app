import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { uploadStore } from "../middlewares/uploadStore";

// Uploaded photos are bound to a room and a player: POST /upload and GET /temp need the player's room code and
// rejoin token, only room members can see a room's photos, and the files are deleted when the game ends or the
// room is emptied/closed (EXP-069, EXP-070).

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-access-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  delete process.env.UPLOAD_RATE_WINDOW_MS;
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

const authHeaders = (m: Pick<Member, "gameCode" | "token">) => ({ Authorization: `Bearer ${m.token}`, "X-Game-Code": m.gameCode });

function upload(headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  return fetch(`${url}/upload`, { method: "POST", body: form, headers });
}

async function uploadAs(m: Member): Promise<string> {
  const res = await upload(authHeaders(m));
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${url}${p}`, { headers });
const onDisk = (p: string) => fs.existsSync(path.join(UPLOAD_DIR, path.basename(p)));
const filesOnDisk = () => fs.readdirSync(UPLOAD_DIR).filter((f) => /^[0-9a-f]{32}\./.test(f));

/** Starts the game and resolves the member that got your-turn (the awaited photo owner). */
async function startAndGetOwner(members: Member[]): Promise<Member> {
  const started = members.map((m) => once(m.socket, "game-started"));
  members[0].socket.emit("start-game");
  await Promise.all(started);
  const turn = new Promise<Member>((resolve) => members.forEach((m) => m.socket.once("your-turn", () => resolve(m))));
  members.forEach((m) => m.socket.emit("im-ready"));
  return turn;
}

async function until(cond: () => boolean, ms = 2_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a33" } }).jpeg().toBuffer();
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

describe("POST /upload is bound to a room member", () => {
  it("refuses an upload without credentials (401) or with a wrong token / room (403), writing nothing", async () => {
    const [alice] = await createRoom("alice", "bob");
    const before = filesOnDisk().length;

    const anon = await upload();
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: expect.any(String) });

    expect((await upload({ "X-Game-Code": alice.gameCode })).status).toBe(401); // token missing
    expect((await upload({ Authorization: `Bearer ${alice.token}` })).status).toBe(401); // room missing
    expect((await upload({ ...authHeaders(alice), Authorization: "Bearer not-the-token" })).status).toBe(403);
    expect((await upload({ ...authHeaders(alice), Authorization: `Basic ${alice.token}` })).status).toBe(401);
    expect((await upload(authHeaders({ gameCode: "000000", token: alice.token }))).status).toBe(403);

    const other = (await createRoom("mallory"))[0];
    expect((await upload(authHeaders({ gameCode: alice.gameCode, token: other.token }))).status).toBe(403);

    expect(filesOnDisk().length).toBe(before);
    for (const m of [alice, other]) m.socket.emit("leave-room");
  });

  it("once a round has been played nobody may upload outside their own photo turn", async () => {
    const members = await createRoom("ann", "ben", "cat");
    const owner = await startAndGetOwner(members);
    // Round 1's photo still awaited: planted photos are still accepted from anyone (same rule as plant-photo)
    for (const m of members.filter((x) => x !== owner)) expect((await upload(authHeaders(m))).status).toBe(200);
    const photo = await uploadAs(owner);

    // Not the owner's turn any more once the round is playing, and no more planted photos
    const start = once(owner.socket, "round-start");
    owner.socket.emit("photo-sent", { photo });
    await start;
    for (const m of members) expect((await upload(authHeaders(m))).status).toBe(403);
    members.forEach((m) => m.socket.emit("leave-room"));
  });

  it("photo-sent / plant-photo only take the sender's own uploads in this room", async () => {
    const members = await createRoom("ivy", "jay", "kit");
    const [other] = await createRoom("zed");
    const foreign = await uploadAs(other); // another room
    const started = members.map((m) => once(m.socket, "game-started"));
    members[0].socket.emit("start-game");
    await Promise.all(started);
    const ivys = await uploadAs(members[0]);
    const jays = await uploadAs(members[1]);

    for (const p of [ivys, foreign, "/temp/" + "e".repeat(32) + ".jpg"]) members[1].socket.emit("plant-photo", { photoUrl: p });
    members[1].socket.emit("plant-photo", { photoUrl: jays });
    await until(() => roomManager.getPlayer(members[1].gameCode, "jay")?.plantedPhoto !== undefined);
    expect(roomManager.getPlayer(members[1].gameCode, "jay")!.plantedPhoto).toBe(jays);
    members.forEach((m) => m.socket.emit("leave-room"));
    other.socket.emit("leave-room");
  });

  it("accepts a planted photo from any member before the first round", async () => {
    const members = await createRoom("pia", "pol");
    const started = members.map((m) => once(m.socket, "game-started"));
    members[0].socket.emit("start-game");
    await Promise.all(started);
    for (const m of members) expect(await uploadAs(m)).toMatch(/^\/temp\/[0-9a-f]{32}\.jpg$/);
    members.forEach((m) => m.socket.emit("leave-room"));
  });
});

describe("GET /temp is only for members of the photo's room", () => {
  it("serves the photo to members and refuses everyone else", async () => {
    const [alice, bob] = await createRoom("alice2", "bob2");
    const [eve] = await createRoom("eve");
    const photo = await uploadAs(alice);

    expect((await get(photo, authHeaders(bob))).status).toBe(200);
    const own = await get(photo, authHeaders(alice));
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store, private");
    expect(own.headers.get("etag")).toBeNull(); // no validators: nothing for a cache to revalidate
    expect(own.headers.get("last-modified")).toBeNull();

    const anon = await get(photo);
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: expect.any(String) });
    expect((await get(photo, { ...authHeaders(bob), Authorization: "Bearer wrong" })).status).toBe(403);
    // Member of another room: same answer as a missing file
    const foreign = await get(photo, authHeaders(eve));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: expect.any(String) });
    // The other room's code with this player's token
    expect((await get(photo, authHeaders({ gameCode: eve.gameCode, token: bob.token }))).status).toBe(403);

    // A player who left is no longer a member
    bob.socket.emit("leave-room");
    await until(() => !roomManager.getPlayer(alice.gameCode, "bob2"));
    expect((await get(photo, authHeaders(bob))).status).toBe(403);
    for (const m of [alice, eve]) m.socket.emit("leave-room");
  });
});

describe("uploads are deleted with the game / room", () => {
  it("deletes every photo of the game at game-over: GET → 404, files gone", async () => {
    const members = await createRoom("gil", "hal", "ida");
    const started = members.map((m) => once(m.socket, "game-started"));
    members[0].socket.emit("start-game");
    await Promise.all(started);
    const turn = new Promise<Member>((resolve) => members.forEach((m) => m.socket.once("your-turn", () => resolve(m))));
    members.forEach((m) => m.socket.emit("im-ready"));
    const owner = await turn;
    // Another member's upload while round 1 is awaited (the owner's own earlier one would be replaced, EXP-147)
    const planted = await uploadAs(members.find((m) => m !== owner)!);
    const photo = await uploadAs(owner);
    const start = once(members[0].socket, "round-start");
    owner.socket.emit("photo-sent", { photo });
    await start;
    expect(onDisk(photo) && onDisk(planted)).toBe(true);

    // Two players leave for good → the game ends for the one left
    const [stay, ...leave] = members;
    const over = once(stay.socket, "game-over");
    leave.forEach((m) => m.socket.emit("leave-room"));
    await over;

    await until(() => !onDisk(photo) && !onDisk(planted));
    expect((await get(photo, authHeaders(stay))).status).toBe(404);
    expect((await get(planted, authHeaders(stay))).status).toBe(404);
    // Next game: the member can upload again (planted photo for "Play again")
    expect(await uploadAs(stay)).toMatch(/^\/temp\//);
    stay.socket.emit("leave-room");
  });

  it("deletes a player's photos when they leave or are removed, and the rest when the room empties", async () => {
    const [a, b, c] = await createRoom("jon", "kim", "lou");
    const p1 = await uploadAs(a);
    const p2 = await uploadAs(b);
    const p3 = await uploadAs(c);
    a.socket.emit("leave-room");
    await until(() => !onDisk(p1));
    expect(onDisk(p2) && onDisk(p3)).toBe(true); // the others' photos stay

    // Host (kim, after jon left) kicks lou
    b.socket.emit("remove-player", { username: "lou" });
    await until(() => !onDisk(p3));
    expect(onDisk(p2)).toBe(true);
    b.socket.emit("leave-room");
    await until(() => !onDisk(p2));
  });

  it("keeps the photo on screen when its owner leaves mid-round, until game over", async () => {
    const members = await createRoom("mia", "noa", "oz");
    const owner = await startAndGetOwner(members);
    const photo = await uploadAs(owner);
    const start = once(members[0].socket, "round-start");
    owner.socket.emit("photo-sent", { photo });
    await start;
    const rest = members.filter((m) => m !== owner);
    owner.socket.emit("leave-room");
    await until(() => !roomManager.getPlayer(owner.gameCode, owner.name));
    expect(onDisk(photo)).toBe(true);
    expect((await get(photo, authHeaders(rest[0]))).status).toBe(200);
    rest.forEach((m) => m.socket.emit("leave-room"));
    await until(() => !onDisk(photo));
  });

  it("a release while the file is being written answers 409 and leaves no file", async () => {
    const [a] = await createRoom("pat", "quin");
    const before = filesOnDisk().length;
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "writeFile").mockImplementationOnce(async (...args: Parameters<typeof fs.promises.writeFile>) => {
      uploadStore.releaseRoom(a.gameCode); // game over right while the photo is being saved
      return realWrite(...args);
    });
    const res = await upload(authHeaders(a));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    await until(() => filesOnDisk().length === before);
    expect(uploadStore.countFor(a.gameCode)).toBe(0);
    a.socket.emit("leave-room");
  });

  it("an upload whose room is released while the image is processed is refused (409), nothing stored", async () => {
    const [a] = await createRoom("ray", "sam");
    const before = filesOnDisk().length;
    const sanitize = await import("../controllers/sanitizeImage");
    const real = sanitize.sanitizeImage;
    const spy = vi.spyOn(sanitize, "sanitizeImage").mockImplementationOnce(async (buf: Buffer) => {
      uploadStore.releaseRoom(a.gameCode);
      return real(buf);
    });
    const res = await upload(authHeaders(a));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(filesOnDisk().length).toBe(before);
    a.socket.emit("leave-room");
  });

  it("deletes the room's photos when the room is deleted", async () => {
    const [a] = await createRoom("lea", "max");
    const p = await uploadAs(a);
    roomManager.deleteRoom(a.gameCode);
    await until(() => !onDisk(p));
    expect(uploadStore.countFor(a.gameCode)).toBe(0);
  });
});
