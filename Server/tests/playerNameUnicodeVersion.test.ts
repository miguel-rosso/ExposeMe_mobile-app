import { describe, expect, it } from "vitest";
import {
  EXTENDED_PICTOGRAPHIC_RANGES, UNASSIGNED_EMOJI_RANGES, UNASSIGNED_NON_EMOJI_RANGES,
} from "../managers/asciiConfusables";
import { isValidUsername, nameClash, nameKeys } from "../managers/playerName";

// EXP-284: the lookalike tables are generated with Node 20 (Unicode 15.1), but the server runs on any Node >= 20.9. A
// character a newer Unicode adds is unknown to the tables, so names may not use it on any Node: they all accept the
// same names. Emoji are left out of the tables anyway (drawn in colour), so newer ones are fine on every Node. Every
// non-ASCII character is written as an escape on purpose.

const LAST_CODE_POINT = 0x10ffff;
const UNASSIGNED = /^\p{Cn}$/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

type Ranges = ReadonlyArray<readonly [number, number]>;

const inRanges = (ranges: Ranges, codePoint: number) =>
  ranges.some(([first, last]) => first <= codePoint && codePoint <= last);
const isUnassignedInTables = (codePoint: number) => inRanges(UNASSIGNED_NON_EMOJI_RANGES, codePoint);
const codePointsOf = (ranges: Ranges) =>
  ranges.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset));
const clash = (a: string, b: string) => nameClash(nameKeys(a), nameKeys(b));

describe("characters newer than the lookalike tables", () => {
  it.each([
    ["Latin small s with diagonal stroke (Unicode 16)", "Chri\u{A7CD}"],
    ["Latin capital lambda (Unicode 16)", "\u{A7DA}ex"],
    ["Cyrillic small tje (Unicode 16)", "\u{1C8A}\u043E\u043C"],
    ["Ol Onal letter (Unicode 16)", "\u{1E5D0}"],
    ["Latin capital letter (Unicode 17)", "\u{A7CE}va"],
    ["Telugu letter nakaara pollu (Unicode 17)", "\u{0C5C}"],
  ])("refuses a %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it.each([
    ["CJK Unified Ideographs Extension I (Unicode 15.1)", "\u{2EBF0}"],
    ["Nag Mundari (Unicode 15.0)", "\u{1E4D0}\u{1E4D1}"],
    ["Kannada combining anusvara above right (Unicode 15.0)", "\u0C95\u0CF3"],
    ["emoji shaking face (Unicode 15.0)", "ana \u{1FAE8}"],
    // Emoji are left out of the lookalike tables (drawn in colour), and Unicode reserves their code points in advance
    ["emoji face with bags under eyes (Unicode 16)", "ana \u{1FAE9}"],
    ["emoji fingerprint (Unicode 16)", "\u{1FAC6}"],
    ["emoji distorted face (Unicode 17)", "ana \u{1FAEA}"],
    // Reserved for emoji in Unicode 15.1, given to a non-emoji arrow in Unicode 16: the same answer on every Node
    ["arrow on a code point Unicode 15.1 reserved for emoji (Unicode 16)", "\u{1F8B2}"],
  ])("accepts a %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it("lists every code point the running Node leaves unassigned but emoji (it comes from no newer Unicode)", () => {
    const missing: string[] = [];
    let range = 0; // the ranges are sorted: the first one that doesn't end before the code point
    for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
      while (range < UNASSIGNED_NON_EMOJI_RANGES.length && UNASSIGNED_NON_EMOJI_RANGES[range][1] < codePoint) range += 1;
      const listed = range < UNASSIGNED_NON_EMOJI_RANGES.length && UNASSIGNED_NON_EMOJI_RANGES[range][0] <= codePoint;
      const char = String.fromCodePoint(codePoint);
      if (!listed && UNASSIGNED.test(char) && !EXTENDED_PICTOGRAPHIC.test(char)) missing.push(codePoint.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("lists no code point the running Node reserves for emoji or has assigned to one", () => {
    const emoji = codePointsOf(UNASSIGNED_NON_EMOJI_RANGES)
      .filter((codePoint) => EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint)));
    expect(emoji).toEqual([]);
  });

  it("comes from Unicode 15.1, the Unicode of the oldest Node the server supports", () => {
    expect(isUnassignedInTables(0x2ebf0)).toBe(false); // assigned in 15.1
    expect(isUnassignedInTables(0xa7cb)).toBe(true); // assigned in 16.0
  });
});

// A phone draws an emoji its fonts lack as an empty box, and code points still unassigned as one on every phone: the
// visual keys read every emoji newer than the tables alike, so two names that differ only by one can't share a room.
describe("emoji newer than the lookalike tables", () => {
  it.each([
    ["two code points still reserved", "Ana \u{1FC00}", "Ana \u{1FC01}"],
    ["a reserved code point and a Unicode 16 emoji", "Ana \u{1FC00}", "Ana \u{1FAE9}"],
    ["two Unicode 16 emoji", "Ana \u{1FAE9}", "Ana \u{1FAC6}"],
    ["a Unicode 16 and a Unicode 17 emoji", "Ana \u{1FAE9}", "Ana \u{1FAEA}"],
    ["a reserved code point Unicode 16 gave to an arrow and an emoji", "Ana \u{1F8B2}", "Ana \u{1FAE9}"],
  ])("%s look alike", (_label, a, b) => {
    expect(isValidUsername(a)).toBe(true);
    expect(isValidUsername(b)).toBe(true);
    expect(clash(a, b)).toBe("similar");
  });

  it.each([
    ["a Unicode 15.1 emoji", "Ana \u{1F600}"],
    ["a Unicode 15.0 emoji", "Ana \u{1FAE8}"],
    ["no emoji", "Ana"],
  ])("a Unicode 16 emoji stays apart from %s", (_label, name) => {
    expect(clash("Ana \u{1FAE9}", name)).toBeNull();
  });

  it("lists every code point the running Node leaves unassigned and reserves for emoji", () => {
    const missing: string[] = [];
    for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);
      const reserved = UNASSIGNED.test(char) && EXTENDED_PICTOGRAPHIC.test(char);
      if (reserved && !inRanges(UNASSIGNED_EMOJI_RANGES, codePoint)) missing.push(codePoint.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("shares no code point with the list of refused ones", () => {
    const shared = codePointsOf(UNASSIGNED_EMOJI_RANGES).filter(isUnassignedInTables);
    expect(shared).toEqual([]);
  });
});

// Emoji joiners and presentation selectors are allowed after an emoji of Unicode 15.1 (a fixed list): Unicode 17 took
// 689 code points out of Extended_Pictographic, which the running Node's property would refuse on Node 24 only.
describe("emoji joiners and selectors after a Unicode 15.1 emoji", () => {
  it.each([
    ["an arrow Unicode 15.1 reserved for emoji + emoji selector", "\u{1F8B2}\uFE0F"],
    ["a chess symbol Unicode 15.1 reserved for emoji + emoji selector", "Ana \u{1FA54}\uFE0F"],
    ["an emoji + joiner + an arrow Unicode 15.1 reserved for emoji", "\u{1F600}\u200D\u{1F8B2}"],
    ["a black star (an emoji in Unicode 15.1, not in 17) + emoji selector", "\u2605\uFE0F"],
    ["a red heart + emoji selector", "\u2764\uFE0F"],
  ])("accepts %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    ["a selector after a letter", "Ana\uFE0F"],
    ["a joiner between two letters", "A\u200Dna"],
  ])("refuses %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it("lists every code point the running Node counts as an emoji (it comes from no newer Unicode)", () => {
    const missing: string[] = [];
    for (let codePoint = 0; codePoint <= LAST_CODE_POINT; codePoint += 1) {
      const emoji = EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint));
      if (emoji && !inRanges(EXTENDED_PICTOGRAPHIC_RANGES, codePoint)) missing.push(codePoint.toString(16));
    }
    expect(missing).toEqual([]);
  });

  it("holds every reserved emoji code point and none of the refused ones", () => {
    expect(codePointsOf(UNASSIGNED_EMOJI_RANGES).filter((codePoint) =>
      !inRanges(EXTENDED_PICTOGRAPHIC_RANGES, codePoint))).toEqual([]);
    expect(codePointsOf(EXTENDED_PICTOGRAPHIC_RANGES).filter(isUnassignedInTables)).toEqual([]);
  });
});
