import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadStore } from "../middlewares/uploadStore";
import { acceptsPlantedPhoto } from "../middlewares/uploadAccess";
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
