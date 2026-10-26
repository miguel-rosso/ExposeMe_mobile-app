import fs from "fs";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import sharp from "sharp";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { UPLOAD_PLAYER_RATE_MAX, UPLOAD_REJECTED_MAX } from "../middlewares/rateLimit";

// EXP-147: POST /upload limits. Everyone at a party shares one public IP, so members are never limited by IP: only
// rejected requests (no / wrong credentials) count per IP, and members have their own per-member (and per-room)
// budget. Neither a stranger on the Wi-Fi nor a member who hit their own limit can make another member's upload fail.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-upload-rate-limits-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  // Defaults, even if the shell exports a lab override
  for (const name of ["UPLOAD_RATE_WINDOW_MS", "UPLOAD_REJECTED_MAX", "UPLOAD_PLAYER_RATE_MAX", "UPLOAD_ROOM_RATE_MAX"]) {
    delete process.env[name];
  }
  return dir;
});

let url: string;
let jpeg: Buffer;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Joins `gameCode` (null: creates a room) as `username` on a new socket; with `rejoinToken`, rejoins that player. */
async function join(gameCode: string | null, username: string, rejoinToken?: string) {
  const socket = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(socket);
  await once(socket, "connect");
  const res = once<{ room: { gameCode: string }; rejoinToken: string }>(socket, "room-of-game");
  socket.emit("join-create-game", { gameCode, username, rejoinToken });
  const { room, rejoinToken: token } = await res;
  return {
    socket,
    gameCode: room.gameCode,
    token,
    headers: { Authorization: `Bearer ${token}`, "X-Game-Code": room.gameCode },
  };
}

function upload(headers: Record<string, string>) {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
  return fetch(`${url}/upload`, { method: "POST", body: form, headers });
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#33a" } }).jpeg().toBuffer();
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

describe("POST /upload rate limits", () => {
  it("per member: 429 once a member fills their window; another member on the same IP still uploads", async () => {
    const hal = await join(null, "hal");
    const ida = await join(hal.gameCode, "ida");
    for (let i = 0; i < UPLOAD_PLAYER_RATE_MAX; i++) expect((await upload(hal.headers)).status).toBe(200);
    const limited = await upload(hal.headers);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // hal keeps hammering while limited: none of it is charged to the IP, ida's budget is untouched
    for (let i = 0; i < 3 * UPLOAD_REJECTED_MAX; i++) expect((await upload(hal.headers)).status).toBe(429);
    for (let i = 0; i < UPLOAD_PLAYER_RATE_MAX; i++) expect((await upload(ida.headers)).status).toBe(200);
  });

  it("EXP-153: a member who rejoins (same name and token, new socket) keeps the quota they used up", async () => {
    const lee = await join(null, "lee");
    const max = await join(lee.gameCode, "max");
    const started = once(lee.socket, "game-started");
    lee.socket.emit("start-game");
    await started;

    for (let i = 0; i < UPLOAD_PLAYER_RATE_MAX; i++) expect((await upload(max.headers)).status).toBe(200);
    expect((await upload(max.headers)).status).toBe(429);

    max.socket.disconnect();
    const back = await join(max.gameCode, "max", max.token);
    expect(back.token).toBe(max.token); // the same player, not a new seat
    expect((await upload(back.headers)).status).toBe(429);
  });

  it("per IP, rejected requests only: a non-member hammering gets 429, members on the same IP don't", async () => {
    const kim = await join(null, "kim");
    const wrong = { ...kim.headers, Authorization: "Bearer not-the-token" };
    for (let i = 0; i < UPLOAD_REJECTED_MAX; i++) {
      expect((await upload(i % 2 ? wrong : {})).status).toBe(i % 2 ? 403 : 401);
    }
    const limited = await upload({});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // EXP-154: a well-formed but wrong/expired credential is still told to re-authenticate, not to wait
    const expired = await upload(wrong);
    expect(expired.status).toBe(403);
    expect(expired.headers.get("retry-after")).toBeNull();

    expect((await upload(kim.headers)).status).toBe(200);
  });
});
