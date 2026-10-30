import { describe, expect, it } from "vitest";
import { isValidUsername, looksLike, nameKey, sameName, visualKey } from "../managers/playerName";

// EXP-294: a Hangul syllable typed as its conjoining jamo (leading consonant, vowel, optional final consonant) is drawn
// as the same block as the precomposed syllable, so both spellings are the same name. Jamo that NFC can't join into one
// syllable but that are drawn in one block with it (a double consonant or compound vowel typed as two simple jamo) are
// refused.

const FIRST_SYLLABLE = 0xac00;
const LAST_SYLLABLE = 0xd7a3;
const SYLLABLES = Array.from(
  { length: LAST_SYLLABLE - FIRST_SYLLABLE + 1 },
  (_, i) => String.fromCodePoint(FIRST_SYLLABLE + i),
);
/** `text` with each Hangul syllable written as its conjoining jamo. */
const asJamo = (text: string) => text.normalize("NFD");

const JAMO_FINAL_IEUNG = "\u11BC";
const JAMO_EU = "\u1173";

describe("Hangul conjoining jamo", () => {
  it.each(["이민지", "김이수", "위", "의", "으뜸", "잉어"])("%s typed as jamo is the same name", (name) => {
    expect(asJamo(name)).not.toBe(name);
    expect(isValidUsername(asJamo(name))).toBe(true);
    expect(sameName(name, asJamo(name))).toBe(true);
  });

  it("every precomposed syllable shares both keys with its jamo spelling", () => {
    const mismatches = SYLLABLES.filter((syllable) =>
      nameKey(syllable) !== nameKey(asJamo(syllable)) || visualKey(syllable) !== visualKey(asJamo(syllable)));
    expect(mismatches).toEqual([]);
  });

  it("a precomposed syllable followed by a final consonant jamo is the syllable with that final", () => {
    expect(sameName(`이${JAMO_FINAL_IEUNG}`, "잉")).toBe(true);
  });

  it("keeps different syllables apart", () => {
    expect(looksLike(asJamo("이"), "의")).toBe(false);
    expect(looksLike(asJamo("이민지"), "이민자")).toBe(false);
    expect(looksLike(asJamo("이"), "o\u1175")).toBe(false);
  });

  it("accepts every precomposed syllable typed as jamo", () => {
    expect(SYLLABLES.filter((syllable) => !isValidUsername(asJamo(syllable)))).toEqual([]);
  });

  it.each([
    ["\u1100가", "까"],
    ["가\u1175", "개"],
    ["오\u1161", "와"],
    [asJamo("오") + "\u1161", "와"],
    ["각\u11A8", "갂"],
    ["이민지가\u1175", "이민지개"],
  ])("refuses %s, drawn in one block like %s", (jamoSpelling, syllables) => {
    expect(isValidUsername(syllables)).toBe(true);
    expect(isValidUsername(jamoSpelling)).toBe(false);
  });

  it.each([
    ["acute", "\u0301"],
    ["kana dakuten", "\u3099"],
    ["Hebrew hiriq", "\u05B4"],
    ["Hangul single dot tone mark", "\u302E"],
  ])("refuses a vowel jamo after a syllable with a mark (%s) between them", (_label, mark) => {
    expect(isValidUsername(`가${mark}\u1175`)).toBe(false);
  });

  it("accepts a final consonant jamo after a syllable with a mark, which keys as the syllable with that final", () => {
    expect(isValidUsername("가\u0301\u11A8")).toBe(true);
    expect(sameName("가\u0301\u11A8", "각")).toBe(true);
  });

  it("refuses a jamo carrying a combining mark", () => {
    expect(isValidUsername("\u110B\u0301")).toBe(false);
  });

  const LONE_JAMO_NAMES = ["\u110B", "\u1161", "\u11A8", "(\u1173_\u1173)", "o\u1175", "Kim \u1100"];
  it.each(LONE_JAMO_NAMES)("accepts the lone jamo in %s", (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it("a compatibility ieung reads as o, not as a syllable", () => {
    expect(looksLike("\u3147\u3163", "이")).toBe(false);
  });

  it("a lone jamo eu still reads as a prolonged sound mark", () => {
    expect(looksLike(`(${JAMO_EU}_${JAMO_EU})`, "(ー_ー)")).toBe(true);
  });
});

// EXP-324: compatibility jamo (ㄱ, ㅏ) and their half-width forms (ﾡ, ￂ) are drawn as separate letters, one per cell,
// never in one block, so they don't spell the syllable NFKC would compose them into ("ㄱㅏ" is not "가"). Among
// themselves they compare as the same letters, and a lone conjoining jamo, also drawn on its own, reads as its
// compatibility letter, as before.

const FIRST_COMPATIBILITY_JAMO = 0x3131;
const LAST_COMPATIBILITY_JAMO = 0x318e;
/** Each conjoining jamo with the compatibility letter NFKC turns into it (ᄀ: ㄱ). */
const COMPATIBILITY_LETTER_OF = new Map(
  Array.from({ length: LAST_COMPATIBILITY_JAMO - FIRST_COMPATIBILITY_JAMO + 1 }, (_, i) => {
    const letter = String.fromCodePoint(FIRST_COMPATIBILITY_JAMO + i);
    return [letter.normalize("NFKC"), letter];
  }),
);
/**
 * `text` with each Hangul syllable written as compatibility letters (가 as ㄱㅏ; a final consonant with no compatibility
 * letter of its own stays a conjoining jamo).
 */
const asCompatibilityLetters = (text: string) =>
  Array.from(text.normalize("NFD"), (jamo) => COMPATIBILITY_LETTER_OF.get(jamo) ?? jamo).join("");

describe("Hangul compatibility jamo", () => {
  it.each([
    ["\u3131\u314F", "가"],
    ["\u3134\u314F", "나"],
    ["\u3147\u3163", "이"],
    ["\uFFA1\uFFC2", "가"],
    ["\uFFB7\uFFDC", "이"],
    ["가\u3131", "각"],
    ["\u3131가", "까"],
    ["\u3131\u314F민지", "가민지"],
  ])("%s is a different name from %s", (letters, syllables) => {
    expect(isValidUsername(letters)).toBe(true);
    expect(looksLike(letters, syllables)).toBe(false);
  });

  it("no syllable reads like its compatibility letters", () => {
    expect(SYLLABLES.filter((syllable) => looksLike(syllable, asCompatibilityLetters(syllable)))).toEqual([]);
  });

  it.each([
    ["half-width", "\uFFA1\uFFC2", "\u3131\u314F"],
    ["half-width and compatibility mixed", "\uFFA1\u314F", "\u3131\u314F"],
    ["compatibility consonant and lone conjoining vowel", "\u3131\u1161", "\u3131\u314F"],
    ["lone conjoining jamo", "\u1100 \u1161", "\u3131 \u314F"],
    ["lone conjoining consonant", "Kim \u1100", "Kim \u3131"],
  ])("the %s spelling %s is the same name as %s", (_label, spelling, letters) => {
    expect(isValidUsername(spelling)).toBe(true);
    expect(sameName(spelling, letters)).toBe(true);
  });

  it("conjoining jamo that spell a syllable are still that syllable, not its letters", () => {
    expect(sameName(asJamo("가"), "가")).toBe(true);
    expect(looksLike(asJamo("가"), "\u3131\u314F")).toBe(false);
  });
});
