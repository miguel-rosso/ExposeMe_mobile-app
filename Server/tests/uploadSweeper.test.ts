import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startUploadSweeper, sweepUploads, SWEEP_INTERVAL_MS, UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import type { Player, Room } from "../models/interfaces";

// Uploads expire by mtime on disk, so photos left behind by a server restart are still deleted, and /temp
// only serves exact, unexpired upload names.

const STALE = "a".repeat(32) + ".jpg";
const FRESH = "b".repeat(32) + ".png";
const STALE_WEBP = "c".repeat(32) + ".webp";
const NOT_UPLOADS = [".gitkeep", "notes.txt", "a".repeat(31) + ".jpg", "d".repeat(32) + ".gif", "E".repeat(32) + ".jpg"];
const MIN = 60_000;

let dir: string;

function write(name: string, ageMs: number, d = dir) {
  const file = path.join(d, name);
  fs.writeFileSync(file, "x");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

const exists = (name: string) => fs.existsSync(path.join(dir, name));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-sweep-"));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── sweepUploads ──
describe("sweepUploads", () => {
  it("deletes upload files older than the TTL and keeps fresh and non-upload files", async () => {
    const now = Date.now();
    write(STALE, UPLOAD_TTL_MS + MIN);
    write(STALE_WEBP, 24 * 60 * MIN);
    write(FRESH, UPLOAD_TTL_MS - MIN);
    for (const n of NOT_UPLOADS) write(n, 24 * 60 * MIN);
    fs.mkdirSync(path.join(dir, "f".repeat(32) + ".jpg")); // a directory with an upload-like name is left alone
    const fresh: Array<[string, number]> = [];

    const deleted = await sweepUploads(dir, UPLOAD_TTL_MS, now, (n, r) => fresh.push([n, r]));

    expect(deleted.sort()).toEqual([STALE, STALE_WEBP].sort());
    expect(exists(STALE)).toBe(false);
    expect(exists(STALE_WEBP)).toBe(false);
    expect(exists(FRESH)).toBe(true);
    for (const n of NOT_UPLOADS) expect(exists(n)).toBe(true);
    expect(exists("f".repeat(32) + ".jpg")).toBe(true);
    expect(fresh).toHaveLength(1);
    expect(fresh[0][0]).toBe(FRESH);
    const mtime = fs.statSync(path.join(dir, FRESH)).mtimeMs;
    expect(fresh[0][1]).toBe(mtime + UPLOAD_TTL_MS);
  });

  it("uses the given clock: a file is deleted exactly once it reaches the TTL", async () => {
    const now = Date.now();
    write(FRESH, 0);
    expect(await sweepUploads(dir, UPLOAD_TTL_MS, now + UPLOAD_TTL_MS - 1_000)).toEqual([]);
    expect(await sweepUploads(dir, UPLOAD_TTL_MS, now + UPLOAD_TTL_MS + 1_000)).toEqual([FRESH]);
  });

  it("returns [] for a missing directory", async () => {
    expect(await sweepUploads(path.join(dir, "nope"))).toEqual([]);
  });
});

// ── startUploadSweeper (fake clock) ──
describe("startUploadSweeper", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  it("deletes stale leftovers at startup and every other upload by its exact deadline, not a sweep later", async () => {
    write(STALE, UPLOAD_TTL_MS + 1_000); // left by a previous process
    write(FRESH, UPLOAD_TTL_MS - 2 * MIN); // expires in 2 min, before the first periodic sweep
    const later = "e".repeat(32) + ".jpg";
    write(later, 7 * MIN); // expires at +23 min, between the sweeps at +20 and +25
    write(".gitkeep", 24 * 60 * MIN);

    const sweeper = startUploadSweeper(dir);
    try {
      await sweeper.idle();
      expect(exists(STALE)).toBe(false);
      expect(exists(FRESH)).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * MIN - 1_000);
      await sweeper.idle();
      expect(exists(FRESH)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_100); // just past its deadline, 3 min before the next sweep
      await sweeper.idle();
      expect(exists(FRESH)).toBe(false);

      // Step through the periodic sweeps; "later" must go at +23 min, not at the +25 min sweep
      for (let t = 2 * MIN + 100; t < 23 * MIN - 1_000; ) {
        const step = Math.min(MIN, 23 * MIN - 1_000 - t);
        await vi.advanceTimersByTimeAsync(step);
        await sweeper.idle();
        t += step;
      }
      expect(exists(later)).toBe(true);
      await vi.advanceTimersByTimeAsync(1_100);
      await sweeper.idle();
      expect(exists(later)).toBe(false);
      expect(exists(".gitkeep")).toBe(true);
    } finally {
      sweeper.stop();
    }
  });

  it("uses unref'd timers that stop() clears, including pending per-file deadlines", async () => {
    write(FRESH, UPLOAD_TTL_MS - MIN);
    const sweeper = startUploadSweeper(dir);
    await sweeper.idle();
    expect(vi.getTimerCount()).toBe(2); // interval + FRESH's deadline
    sweeper.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(UPLOAD_TTL_MS);
    expect(exists(FRESH)).toBe(true);
  });

  it("unrefs the interval (SWEEP_INTERVAL_MS) so it never keeps the process alive", () => {
    vi.useRealTimers();
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimer);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      const sweeper = startUploadSweeper(dir);
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), SWEEP_INTERVAL_MS);
      expect(unref).toHaveBeenCalled();
      sweeper.stop();
      expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

// ── /temp serving + wiring on the real app ──
describe("GET /temp on the app", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-serve-"));
  let mod: typeof import("../app");
  let port: number;

  // /temp only serves a room's photos to its members (uploadAccess): a fake room whose member sends AUTH
  const AUTH = { authorization: "Bearer member-token", "x-game-code": "123456" };
  const raw = (method: string, p: string, headers: Record<string, string> = AUTH) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    process.env.UPLOAD_DIR = appDir;
    vi.resetModules();
    mod = await import("../app");
    const { setUploadRooms } = await import("../middlewares/uploadAccess");
    const { uploadStore } = await import("../middlewares/uploadStore");
    const player = { username: "ann", rejoinToken: "member-token" } as Player;
    const room = { gameCode: "123456", phase: null, players: [player], currentPlayer: null } as unknown as Room;
    setUploadRooms({
      getRoom: (code) => (code === room.gameCode ? room : undefined),
      authenticate: (code, token) => (code === room.gameCode && token === player.rejoinToken ? { room, player } : null),
    });
    for (const name of [STALE, FRESH]) uploadStore.register(name, { gameCode: room.gameCode, username: "ann", file: path.join(appDir, name) }, 0);
    mod.server.listen(0);
    await new Promise((r) => mod.server.once("listening", r));
    port = (mod.server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    write(STALE, UPLOAD_TTL_MS + MIN, appDir);
    write(FRESH, MIN, appDir);
    write(".gitkeep", 0, appDir);
  });
  afterAll(() => {
    delete process.env.UPLOAD_DIR;
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  it("serves a fresh upload (GET and HEAD) with no-store caching", async () => {
    const got = await raw("GET", `/temp/${FRESH}`);
    expect(got.status).toBe(200);
    expect(got.body).toBe("x");
    expect(got.headers["cache-control"]).toBe("no-store, private");
    expect((await raw("HEAD", `/temp/${FRESH}`)).status).toBe(200);
  });

  it.each([
    ["plain", `/temp/${STALE}`],
    ["%61-encoded hex", `/temp/%61${STALE.slice(1)}`],
    ["%2E-encoded dot", `/temp/${STALE.replace(".", "%2E")}`],
    ["./ segment", `/temp/./${STALE}`],
    ["x/../ segment", `/temp/x/../${STALE}`],
    ["%2F prefix", `/temp/%2F${STALE}`],
    ["uppercase extension", `/temp/${STALE.replace(".jpg", ".JPG")}`],
  ])("refuses an expired upload: %s", async (_label, p) => {
    expect((await raw("GET", p)).status).toBe(404);
  });

  it("requires a room member's credentials", async () => {
    expect((await raw("GET", `/temp/${FRESH}`, {})).status).toBe(401);
    expect((await raw("GET", `/temp/${FRESH}`, { ...AUTH, authorization: "Bearer other" })).status).toBe(403);
  });

  it("refuses anything that is not an upload name", async () => {
    expect((await raw("GET", "/temp/.gitkeep")).status).toBe(404);
    expect((await raw("GET", "/temp/")).status).toBe(404);
    expect((await raw("GET", `/temp/${"9".repeat(32)}.jpg`)).status).toBe(404); // missing
  });

  it("clears the sweep timers when the HTTP server closes", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      await new Promise((r) => mod.io.close(() => r(undefined)));
      expect(mod.server.listening).toBe(false);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});
