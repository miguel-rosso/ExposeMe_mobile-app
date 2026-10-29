import { describe, expect, it } from "vitest";
import { isValidUsername, looksLike, nameKey, sameName, visualKey } from "../managers/playerName";

// EXP-287: a Japanese voicing mark (dakuten U+3099, handakuten U+309A) on a kana that takes it makes another kana, so
// names that only differ by one are different names. Anywhere else the mark is dropped like any other mark, and any
// other mark on a kana with a voiced form is refused, so neither can be used to dodge the checks against a name that
// reads the same.

const DAKUTEN = "\u3099";
const HANDAKUTEN = "\u309A";
const HALFWIDTH_DAKUTEN = "\uFF9E";
const HALFWIDTH_HANDAKUTEN = "\uFF9F";
const SPACING_DAKUTEN = "\u309B";
const SPACING_HANDAKUTEN = "\u309C";
const RING_ABOVE = "\u030A";
const DOUBLE_ACUTE = "\u030B";
const DIAERESIS = "\u0308";
const LONG_STROKE_OVERLAY = "\u0336";
const LEFT_ANGLE_BRACKET = "\u3008";

const KANA_BLOCKS = Array.from({ length: 0x30ff - 0x3040 + 1 }, (_, i) => String.fromCodePoint(0x3040 + i));
/** Every precomposed kana with a voicing mark (だ, ぱ, ダ, パ, ヴ, ヷ, ゞ...). */
const VOICED_KANA = KANA_BLOCKS.filter((kana) => /^\P{M}[\u3099\u309A]$/u.test(kana.normalize("NFD")));
/** Nonspacing marks other than the voicing marks that a valid name may hold on a non-kana letter. */
const OTHER_MARKS = Array.from({ length: 0x10000 }, (_, i) => String.fromCodePoint(i))
  .filter((char) => /^\p{Mn}$/u.test(char) && !/[\u3099\u309A]/u.test(char) && isValidUsername(`x${char}`));

describe("Japanese voicing marks", () => {
  it.each([
    ["たいき", "だいき"],
    ["はな", "ぱな"],
    ["はな", "ばな"],
    ["ばな", "ぱな"],
    ["ハル", "バル"],
    ["ハル", "パル"],
    ["ウタ", "ヴタ"],
    // Half-width katakana with their own voicing marks read as the full-width forms
    ["ﾊﾙ", `ﾊ${HALFWIDTH_DAKUTEN}ﾙ`],
    [`ﾊ${HALFWIDTH_DAKUTEN}ﾙ`, `ﾊ${HALFWIDTH_HANDAKUTEN}ﾙ`],
    // So do spacing voicing marks typed after a kana
    ["はな", `は${SPACING_DAKUTEN}な`],
    [`は${SPACING_DAKUTEN}な`, `は${SPACING_HANDAKUTEN}な`],
    // く has a symbol prototype (❬): its voiced form ぐ still differs from it
    ["くみ", "ぐみ"],
  ])("%j and %j are different names", (a, b) => {
    expect(isValidUsername(a) && isValidUsername(b)).toBe(true);
    expect(sameName(a, b)).toBe(false);
    expect(looksLike(a, b)).toBe(false);
  });

  it.each(VOICED_KANA)("precomposed %s is the same name as its kana plus a combining voicing mark", (voiced) => {
    const decomposed = voiced.normalize("NFD");
    expect(isValidUsername(`x${decomposed}x`)).toBe(true);
    expect(nameKey(decomposed)).toBe(nameKey(voiced));
    expect(visualKey(decomposed)).toBe(visualKey(voiced));
    expect(sameName(`x${voiced}x`, `x${decomposed}x`)).toBe(true);
  });

  it.each([
    ["だいき", `た${DAKUTEN}いき`],
    ["ぱな", `は${HANDAKUTEN}な`],
    ["バル", `ハ${DAKUTEN}ル`],
    ["ヴタ", `ウ${DAKUTEN}タ`],
    // Half-width katakana compare with full-width as before, now with their voicing
    ["バル", `ﾊ${HALFWIDTH_DAKUTEN}ﾙ`],
    ["パル", `ﾊ${HALFWIDTH_HANDAKUTEN}ﾙ`],
    ["バル", `ﾊ${DAKUTEN}ﾙ`],
    ["ハル", "ﾊﾙ"],
    // A spacing voicing mark after a kana voices it, like the half-width one
    ["ばな", `は${SPACING_DAKUTEN}な`],
    ["ぱな", `は${SPACING_HANDAKUTEN}な`],
    ["バル", `ﾊ${SPACING_DAKUTEN}ﾙ`],
  ])("%j and %j are the same name", (a, b) => {
    expect(isValidUsername(b)).toBe(true);
    expect(sameName(a, b)).toBe(true);
  });

  // Where the mark can't voice its letter it is dropped as before
  it.each([
    ["Latin a", "ana", `a${DAKUTEN}na`],
    ["Latin a, handakuten", "ana", `a${HANDAKUTEN}na`],
    ["Latin a, half-width dakuten", "ana", `a${HALFWIDTH_DAKUTEN}na`],
    ["a kanji", "漢字", `漢${DAKUTEN}字`],
    ["ん, which has no voiced form", "ほん", `ほん${DAKUTEN}`],
    ["あ, half-width", "あい", `あ${HALFWIDTH_DAKUTEN}い`],
  ])("a voicing mark after %s is dropped (%j and %j are the same name)", (_, plain, marked) => {
    expect(isValidUsername(marked)).toBe(true);
    expect(sameName(plain, marked)).toBe(true);
  });

  it("a spacing voicing mark after anything but a kana that takes it stays as before", () => {
    for (const letter of ["a", "あ", "ん", "か"]) {
      const mark = letter === "か" ? SPACING_HANDAKUTEN : SPACING_DAKUTEN;
      expect(isValidUsername(`${letter}${mark}`)).toBe(true);
      expect(sameName(`${letter}${mark}`, `${letter} ${mark}`)).toBe(true);
      expect(sameName(`${letter}${mark}`, letter)).toBe(false);
    }
  });

  it("kaomoji with half-width voicing marks after kana without a voiced form stay valid", () => {
    expect(isValidUsername("(ﾉ\uFF9F\u2200\uFF9F)ﾉ")).toBe(true);
  });

  it("a voicing mark after a Latin letter still meets lookalikes of the plain name", () => {
    expect(looksLike("Alice", `AI${DAKUTEN}ice`)).toBe(true);
  });

  it("a symbol drawn like く with a dakuten looks like ぐ", () => {
    for (const lookalike of [LEFT_ANGLE_BRACKET, "\u27E8", "\u276C", "\u2329"]) {
      expect(isValidUsername(`${lookalike}${DAKUTEN}み`)).toBe(true);
      expect(looksLike("ぐみ", `${lookalike}${DAKUTEN}み`)).toBe(true);
      expect(looksLike(`く${DAKUTEN}み`, `${lookalike}${DAKUTEN}み`)).toBe(true);
    }
    expect(sameName(LEFT_ANGLE_BRACKET, `${LEFT_ANGLE_BRACKET}${DAKUTEN}`)).toBe(true);
  });

  // Keys alone (names a room never holds): another mark doesn't stop a kana from taking its voicing mark
  it("a kana with any other mark before its dakuten keeps the voiced key", () => {
    expect(OTHER_MARKS.length).toBeGreaterThan(1000);
    const unvoiced = OTHER_MARKS.filter((mark) => nameKey(`た${mark}${DAKUTEN}いき`) !== nameKey("だいき"));
    expect(unvoiced.map((mark) => mark.codePointAt(0)?.toString(16))).toEqual([]);
  });
});

// Japanese puts no other mark on a kana: one drawn like a voicing mark, or a second voicing mark, would make a name that
// reads as a voiced kana while its keys see another one
describe("marks on kana", () => {
  it.each([
    ["ring above (drawn like a handakuten)", `は${RING_ABOVE}な`],
    ["ring above on katakana", `ハ${RING_ABOVE}ル`],
    ["ring above on half-width katakana", `ﾊ${RING_ABOVE}ﾙ`],
    ["double acute (drawn like a dakuten)", `た${DOUBLE_ACUTE}いき`],
    ["diaeresis", `た${DIAERESIS}いき`],
    ["handakuten then dakuten", `た${HANDAKUTEN}${DAKUTEN}いき`],
    ["dakuten then handakuten", `は${DAKUTEN}${HANDAKUTEN}な`],
    ["a second dakuten", `だ${DAKUTEN}いき`],
    ["dakuten on a semi-voiced kana", `ぱ${DAKUTEN}な`],
    ["half-width handakuten then dakuten", `た${HALFWIDTH_HANDAKUTEN}${HALFWIDTH_DAKUTEN}いき`],
    ["half-width dakuten then handakuten", `ﾊ${HALFWIDTH_DAKUTEN}${HALFWIDTH_HANDAKUTEN}ﾙ`],
    ["handakuten on a kana that only takes dakuten", `か${HANDAKUTEN}な`],
    ["an overlay before the dakuten", `た${LONG_STROKE_OVERLAY}${DAKUTEN}いき`],
    ["a mark on a symbol drawn like く", `${LEFT_ANGLE_BRACKET}${RING_ABOVE}`],
    ["handakuten on a symbol drawn like く", `${LEFT_ANGLE_BRACKET}${HANDAKUTEN}`],
  ])("a name with %s on a kana is refused (%j)", (_, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it("other scripts keep their marks", () => {
    expect(isValidUsername(`a${RING_ABOVE}na`)).toBe(true);
    expect(isValidUsername(`漢${DIAERESIS}`)).toBe(true);
  });
});
