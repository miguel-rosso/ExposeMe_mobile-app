import fs from "fs";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { UPLOAD_PLAYER_RATE_MAX, UPLOAD_ROOM_RATE_MAX } from "../middlewares/rateLimit";

// EXP-155: the per-room POST /upload budget. The limits are read when rateLimit.ts loads, so this file sets small
// ones before any import (vi.hoisted); vitest gives each test file its own module registry.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-room-rate-limit-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  for (const name of ["UPLOAD_RATE_WINDOW_MS", "UPLOAD_REJECTED_MAX"]) delete process.env[name];
  process.env.UPLOAD_ROOM_RATE_MAX = "3";
  process.env.UPLOAD_PLAYER_RATE_MAX = "2";
  return dir;
});

let url: string;
let jpeg: Buffer;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function join(gameCode: string | null, username: string) {
  const socket = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(socket);
  await once(socket, "connect");
  const res = once<{ room: { gameCode: string }; rejoinToken: string }>(socket, "room-of-game");
  socket.emit("join-create-game", { gameCode, username });
  const { room, rejoinToken } = await res;
  return { gameCode: room.gameCode, headers: { Authorization: `Bearer ${rejoinToken}`, "X-Game-Code": room.gameCode } };
}

function upload(headers: Record<string, string>) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  return fetch(`${url}/upload`, { method: "POST", body: form, headers });
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  delete process.env.UPLOAD_ROOM_RATE_MAX;
  delete process.env.UPLOAD_PLAYER_RATE_MAX;
});

describe("POST /upload per-room limit", () => {
  it("the room's uploads beyond its budget get 429 even under each member's own limit; another room still uploads", async () => {
    expect([UPLOAD_ROOM_RATE_MAX, UPLOAD_PLAYER_RATE_MAX]).toEqual([3, 2]); // the env above took effect

    const ann = await join(null, "ann");
    const ben = await join(ann.gameCode, "ben");
    const cat = await join(null, "cat"); // a different room
    expect(cat.gameCode).not.toBe(ann.gameCode);

    expect((await upload(ann.headers)).status).toBe(200);
    expect((await upload(ann.headers)).status).toBe(200);
    expect((await upload(ben.headers)).status).toBe(200);

    // ben has used 1 of his 2, but it's the room's 4th
    const limited = await upload(ben.headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await upload(cat.headers)).status).toBe(200);
  }, 20_000);
});
