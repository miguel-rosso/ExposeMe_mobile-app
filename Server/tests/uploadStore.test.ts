import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Default storage limits (no env override)
vi.hoisted(() => {
  delete process.env.UPLOAD_STORED_MAX;
  delete process.env.UPLOAD_LOBBY_PER_IP_MAX;
});

import { UPLOAD_LOBBY_PER_IP_MAX, UPLOAD_STORED_MAX, UploadStore } from "../middlewares/uploadStore";
import { acceptsPlantedPhoto } from "../middlewares/uploadAccess";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import type { Room } from "../models/interfaces";

// Per-room registry of uploaded photos (EXP-070): who uploaded each file, and deletion of a room's files when its
// game ends or the room closes. Uploads authorized before a release are refused when they finish (epoch).

let dir: string;
let store: UploadStore;
const NAME_A = "a".repeat(32) + ".jpg";
const NAME_B = "b".repeat(32) + ".jpg";
const NAME_C = "c".repeat(32) + ".png";

const put = (name: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x");
  return file;
};

async function settled(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exposeme-store-"));
  store = new UploadStore();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("UploadStore", () => {
  it("binds each upload to its room and player", () => {
    expect(store.register(NAME_A, { gameCode: "111111", username: "ann", file: put(NAME_A) }, store.epoch("111111"))).toBe(true);
    expect(store.get(NAME_A)).toMatchObject({ gameCode: "111111", username: "ann" });
    expect(store.get(NAME_B)).toBeUndefined();
    expect(store.countFor("111111")).toBe(1);
    expect(store.countFor("222222")).toBe(0);
  });

  it("releaseRoom deletes only that room's files and forgets them", async () => {
    const a = put(NAME_A), b = put(NAME_B), c = put(NAME_C);
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: a }, 0);
    store.register(NAME_B, { gameCode: "111111", username: "ben", file: b }, 0);
    store.register(NAME_C, { gameCode: "222222", username: "cat", file: c }, 0);

    store.releaseRoom("111111");
    expect(store.get(NAME_A)).toBeUndefined();
    expect(store.countFor("111111")).toBe(0);
    await settled(() => !fs.existsSync(a) && !fs.existsSync(b));
    expect(fs.existsSync(c)).toBe(true);
    expect(store.get(NAME_C)).toBeDefined();
  });

  it("refuses to register an upload authorized before the room was released", () => {
    const epoch = store.epoch("111111");
    store.releaseRoom("111111");
    expect(store.register(NAME_A, { gameCode: "111111", username: "ann", file: put(NAME_A) }, epoch)).toBe(false);
    expect(store.get(NAME_A)).toBeUndefined();
    // A new upload after the release is fine
    expect(store.register(NAME_B, { gameCode: "111111", username: "ann", file: put(NAME_B) }, store.epoch("111111"))).toBe(true);
  });

  it("dropRoom releases the files of a deleted room; a missing file is not an error", async () => {
    const a = put(NAME_A);
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: a }, 0);
    store.register(NAME_B, { gameCode: "111111", username: "ann", file: path.join(dir, NAME_B) }, 0); // never written
    store.dropRoom("111111");
    await settled(() => !fs.existsSync(a));
    expect(store.countFor("111111")).toBe(0);
  });

  it("releasePlayer deletes only that player's files in that room, except the one kept on screen", async () => {
    const a = put(NAME_A), b = put(NAME_B), c = put(NAME_C);
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: a }, 0);
    store.register(NAME_B, { gameCode: "111111", username: "ann", file: b }, 0);
    store.register(NAME_C, { gameCode: "111111", username: "ben", file: c }, 0);
    store.releasePlayer("111111", "ann", NAME_B);
    await settled(() => !fs.existsSync(a));
    expect(fs.existsSync(b) && fs.existsSync(c)).toBe(true);
    expect(store.get(NAME_B)).toBeDefined();
    expect(store.countFor("111111")).toBe(2);
  });

  it("clears the TTL timer when a record goes away early", () => {
    const timer = setTimeout(() => {}, 60_000);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: put(NAME_A), timer }, 0);
    store.releaseRoom("111111");
    expect(clear).toHaveBeenCalledWith(timer);
    clear.mockRestore();
    clearTimeout(timer);
  });

  // EXP-147: re-picking a photo replaces the player's previous unused upload instead of piling up files
  it("releaseSuperseded deletes the player's older unused uploads of the same round, keeping the newest earlier one", async () => {
    const NAME_D = "d".repeat(32) + ".jpg", NAME_E = "e".repeat(32) + ".jpg", NAME_F = "f".repeat(32) + ".jpg";
    const [a, b, c, d, f, e] = [NAME_A, NAME_B, NAME_C, NAME_D, NAME_F, NAME_E].map(put);
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: a, round: 0 }, 0); // superseded
    store.register(NAME_B, { gameCode: "111111", username: "ann", file: b, round: 0 }, 0); // planted
    store.register(NAME_C, { gameCode: "111111", username: "ann", file: c, round: 1 }, 0); // older round (shown)
    store.register(NAME_D, { gameCode: "111111", username: "ben", file: d, round: 0 }, 0); // another player
    store.register(NAME_F, { gameCode: "111111", username: "ann", file: f, round: 0 }, 0); // newest earlier: may be in use
    store.replacePlanted(undefined, `/temp/${NAME_B}`);
    store.register(NAME_E, { gameCode: "111111", username: "ann", file: e, round: 0 }, 0); // the new upload

    store.releaseSuperseded(NAME_E);
    await settled(() => !fs.existsSync(a));
    expect(store.get(NAME_A)).toBeUndefined();
    for (const [name, file] of [[NAME_B, b], [NAME_C, c], [NAME_D, d], [NAME_F, f], [NAME_E, e]]) {
      expect(store.get(name)).toBeDefined();
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it("releaseSuperseded only replaces uploads of the same kind (a turn upload never drops a lobby pick)", () => {
    const NAME_D = "d".repeat(32) + ".jpg";
    for (const name of [NAME_A, NAME_B]) {
      store.register(name, { gameCode: "111111", username: "ann", file: put(name), round: 0, kind: "planted" }, 0);
    }
    for (const name of [NAME_C, NAME_D]) {
      store.register(name, { gameCode: "111111", username: "ann", file: put(name), round: 0, kind: "turn" }, 0);
      store.releaseSuperseded(name);
    }
    for (const name of [NAME_A, NAME_B, NAME_C, NAME_D]) expect(store.get(name)).toBeDefined();
  });

  it("releaseSuperseded keeps the photo on screen", () => {
    const NAME_D = "d".repeat(32) + ".jpg";
    for (const name of [NAME_A, NAME_D, NAME_B, NAME_C]) {
      store.register(name, { gameCode: "111111", username: "ann", file: put(name), round: 2 }, 0);
    }
    store.releaseSuperseded(NAME_C, `/temp/${NAME_A}`);
    expect(store.get(NAME_A)).toBeDefined(); // on screen
    expect(store.get(NAME_D)).toBeUndefined(); // older unused
    expect(store.get(NAME_B)).toBeDefined(); // newest earlier unused
  });

  it("replacePlanted deletes the replaced planted photo, never another player's or the same one", async () => {
    const a = put(NAME_A), b = put(NAME_B), c = put(NAME_C);
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: a, round: 0 }, 0);
    store.register(NAME_B, { gameCode: "111111", username: "ann", file: b, round: 0 }, 0);
    store.register(NAME_C, { gameCode: "111111", username: "ben", file: c, round: 0 }, 0);
    store.replacePlanted(undefined, `/temp/${NAME_A}`);
    store.replacePlanted(`/temp/${NAME_A}`, `/temp/${NAME_A}`); // same photo again: kept
    expect(store.get(NAME_A)).toBeDefined();
    store.replacePlanted(`/temp/${NAME_C}`, `/temp/${NAME_B}`); // not ann's: kept
    expect(store.get(NAME_C)).toBeDefined();
    store.replacePlanted(`/temp/${NAME_A}`, `/temp/${NAME_B}`);
    await settled(() => !fs.existsSync(a));
    expect(store.get(NAME_A)).toBeUndefined();
    expect(store.get(NAME_B)?.planted).toBe(true);
  });

  it("forget drops a single entry (TTL expiry)", () => {
    store.register(NAME_A, { gameCode: "111111", username: "ann", file: put(NAME_A) }, 0);
    store.forget(NAME_A);
    expect(store.get(NAME_A)).toBeUndefined();
    expect(store.countFor("111111")).toBe(0);
  });
});

describe("acceptsPlantedPhoto (POST /upload and plant-photo share it)", () => {
  const room = (phase: Room["phase"], round: number) => ({ phase, round }) as Room;
  it("accepts planted photos until the first round has been played", () => {
    expect(acceptsPlantedPhoto(room(null, 0))).toBe(true); // lobby / ready phase
    expect(acceptsPlantedPhoto(room(null, 7))).toBe(true); // after game over (next game)
    expect(acceptsPlantedPhoto(room("waiting-photo", 0))).toBe(true); // round 1 still awaited (also after skips)
    expect(acceptsPlantedPhoto(room("waiting-photo", 1))).toBe(false);
    for (const phase of ["answering", "reveal", "scores"] as const) expect(acceptsPlantedPhoto(room(phase, 1))).toBe(false);
  });
});

// EXP-195: server-wide storage limits shed lobby photos only; Retry-After is when the oldest counted photo expires
describe("UploadStore.storageRefusal", () => {
  const TTL_S = UPLOAD_TTL_MS / 1000;
  let limited: UploadStore;
  let count = 0;
  /** Registers a photo (no file written) and returns its name. */
  const add = (ip: string, kind: "turn" | "planted", gameCode = "111111") => {
    const name = (++count).toString(16).padStart(32, "0") + ".jpg";
    limited.register(name, { gameCode, username: `u${count}`, file: path.join(dir, name), kind, ip }, limited.epoch(gameCode));
    return name;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    limited = new UploadStore({ storedMax: 3, lobbyPerIpMax: 2 });
  });

  it("defaults: 3000 stored photos server-wide; per IP, several full parties (12 players × ~3 lobby photos) on one Wi-Fi", () => {
    const FULL_PARTY_LOBBY_PHOTOS = 12 * 3;
    expect(UPLOAD_STORED_MAX).toBe(3_000);
    expect(UPLOAD_LOBBY_PER_IP_MAX).toBe(150);
    expect(UPLOAD_LOBBY_PER_IP_MAX).toBeGreaterThanOrEqual(2 * FULL_PARTY_LOBBY_PHOTOS);
  });
  afterEach(() => {
    limited.clear();
    vi.useRealTimers();
  });

  it("refuses lobby photos once the server holds storedMax photos (503), with the oldest photo's expiry as Retry-After", () => {
    add("1.1.1.1", "planted");
    vi.advanceTimersByTime(60_000);
    add("2.2.2.2", "turn");
    add("3.3.3.3", "planted");
    expect(limited.storageRefusal("planted", "4.4.4.4")).toEqual({ status: 503, scope: "storage", retryAfterS: TTL_S - 60 });
    expect(limited.storageRefusal(undefined, "4.4.4.4")).toMatchObject({ status: 503 });
  });

  it("never refuses a turn photo, even past storedMax or the IP's cap", () => {
    for (let i = 0; i < 4; i++) add("1.1.1.1", i < 2 ? "planted" : "turn");
    expect(limited.storageRefusal("turn", "1.1.1.1")).toBeNull();
  });

  it("caps lobby photos per IP (429), counting neither turn photos nor other IPs; forgetting one frees a place", () => {
    limited = new UploadStore({ storedMax: 100, lobbyPerIpMax: 2 });
    add("2.2.2.2", "planted"); // the server's oldest photo, from another IP
    vi.advanceTimersByTime(60_000);
    const first = add("1.1.1.1", "planted", "111111");
    add("1.1.1.1", "turn");
    vi.advanceTimersByTime(60_000);
    expect(limited.storageRefusal("planted", "1.1.1.1")).toBeNull(); // 1 lobby photo + 1 turn photo
    add("1.1.1.1", "planted", "222222");
    // Retry-After: when this IP's oldest lobby photo (stored 60 s ago) expires
    expect(limited.storageRefusal("planted", "1.1.1.1")).toEqual({ status: 429, scope: "lobby-ip", retryAfterS: TTL_S - 60 });
    expect(limited.storageRefusal("planted", "2.2.2.2")).toBeNull();
    limited.forget(first);
    expect(limited.storageRefusal("planted", "1.1.1.1")).toBeNull();
  });
});
