import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// EXP-198: 6-character codes from an unambiguous uppercase alphanumeric alphabet (DEC-022).

/** Codes the generator returns next (then real random ones), to force collisions with live rooms. */
const forced = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock("../managers/roomCode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managers/roomCode")>();
  return { ...actual, randomRoomCode: () => forced.codes.shift() ?? actual.randomRoomCode() };
});

import { isRoomCode, normalizeRoomCode, randomRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../managers/roomCode";
import { RoomManager } from "../managers/RoomManager";

describe("room code alphabet", () => {
  const PINNED_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

  it("is pinned, and the app and the lab bots use the very same one", () => {
    expect(ROOM_CODE_ALPHABET).toBe(PINNED_ALPHABET);
    const repo = path.resolve(__dirname, "../..");
    for (const file of ["Client/app/utils/roomCode.ts", "qa/lab/bots.mjs"]) {
      const source = fs.readFileSync(path.join(repo, file), "utf8");
      expect(source, file).toContain(`const ROOM_CODE_ALPHABET = "${PINNED_ALPHABET}";`);
    }
  });

  it("has 31 distinct uppercase alphanumerics without look-alikes", () => {
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
    expect(ROOM_CODE_ALPHABET).toHaveLength(31);
    expect(ROOM_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    for (const lookAlike of "01OIL") expect(ROOM_CODE_ALPHABET).not.toContain(lookAlike);
  });
});

describe("randomRoomCode", () => {
  it("draws 6 characters from the alphabet, all of them used", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isRoomCode(code)).toBe(true);
      for (const c of code) seen.add(c);
    }
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });
});

describe("normalizeRoomCode / isRoomCode", () => {
  it("trims and uppercases", () => {
    expect(normalizeRoomCode("  k7mq4x ")).toBe("K7MQ4X");
    expect(isRoomCode(normalizeRoomCode("k7mq4x"))).toBe(true);
  });

  // String#toUpperCase maps "ß" → "SS", "ſ" → "S", "ﬀ" → "FF": those would be aliases of real codes
  it.each(["K7MQß", "K7MQ4ſ", "K7MQﬀ", "Ｋ７ＭＱ４Ｘ", "K7MQ4X ", " K7MQ4X"])(
    "keeps non-ASCII input %j malformed (ASCII-only normalization)", (code) => {
      expect(isRoomCode(normalizeRoomCode(code))).toBe(false);
    },
  );

  it.each(["", "K7MQ4", "K7MQ4XZ", "k7mq4x", "123456", "K7MQ0X", "K7MQOX", "K7 Q4X", "K7MQ4X\n"])("rejects %j", (code) => {
    expect(isRoomCode(code)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const v of [null, undefined, 123456, ["K7MQ4X"], { code: "K7MQ4X" }]) expect(isRoomCode(v)).toBe(false);
  });
});

describe("RoomManager codes", () => {
  const rm = new RoomManager();
  afterEach(() => {
    rm.clear();
    forced.codes = [];
  });

  it("never reuses the code of a live room", () => {
    forced.codes = ["K7MQ4X"];
    expect(rm.createRoom("a", "s1").gameCode).toBe("K7MQ4X");
    // The generator hits the live code twice before a free one: the new room gets the free one
    forced.codes = ["K7MQ4X", "K7MQ4X", "ZZZZZZ"];
    expect(rm.createRoom("b", "s2").gameCode).toBe("ZZZZZZ");
    expect(forced.codes).toEqual([]);
  });
});
