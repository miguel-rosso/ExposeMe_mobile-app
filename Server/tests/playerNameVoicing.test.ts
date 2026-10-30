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

// EXP-320: a voicing mark typed after a space is drawn where a spacing ゛ or ゜ would be (a combining one sits on the
// space, a half-width one fills the rest of the cell), so it voices the kana before the space like the spacing mark.
// Spacing marks also voice symbols and kanji that only NFKC turns into a kana lookalike.
describe("voicing marks after a space", () => {
  it.each([
    ["combining dakuten", `た ${DAKUTEN}いき`, "だいき"],
    ["combining handakuten", `は ${HANDAKUTEN}な`, "ぱな"],
    ["half-width dakuten", `た ${HALFWIDTH_DAKUTEN}いき`, "だいき"],
    ["half-width handakuten after half-width katakana", `ﾊ ${HALFWIDTH_HANDAKUTEN}ﾙ`, "パル"],
  ])("a %s after a space reads like the spacing mark (%j is the same name as %j)", (_label, spaced, voiced) => {
    expect(isValidUsername(spaced)).toBe(true);
    expect(sameName(spaced, voiced)).toBe(true);
  });

  it("after a letter that doesn't take it, a voicing mark after a space keys like the spacing mark, as before", () => {
    for (const spaced of [`a ${DAKUTEN}b`, `a ${HALFWIDTH_DAKUTEN}b`, `あ ${DAKUTEN}い`]) {
      const spacing = spaced.replace(/ ./u, SPACING_DAKUTEN);
      expect(isValidUsername(spaced)).toBe(true);
      expect(sameName(spaced, spacing)).toBe(true);
      expect(sameName(spaced, spaced.replace(/ ./u, ""))).toBe(false);
    }
  });

  it("a mark on a kana after the space-and-voicing-mark spelling is refused like on the voiced kana", () => {
    expect(isValidUsername(`た ${DAKUTEN}${DIAERESIS}いき`)).toBe(false);
  });

  it.each([
    ["Kangxi radical power (NFKC: kanji power, drawn like カ)", "\u2F12", "ガ"],
    ["left-pointing angle bracket (NFKC: CJK angle bracket, drawn like く)", "\u2329", "ぐ"],
  ])("a spacing dakuten after %s %j looks like %j", (_label, symbol, voiced) => {
    expect(isValidUsername(`${symbol}${SPACING_DAKUTEN}み`)).toBe(true);
    expect(looksLike(`${symbol}${SPACING_DAKUTEN}み`, `${voiced}み`)).toBe(true);
  });

  // Other marks on the space may come before the voicing mark (NFC/NFD order a dot below or an acute after it)
  it.each([
    ["dot below", "\u0323"],
    ["acute", "\u0301"],
  ])("another mark (%s) on the space, before or after the voicing mark, is refused like on the voiced kana", (_label, mark) => {
    for (const voicing of [DAKUTEN, HALFWIDTH_DAKUTEN]) {
      expect(isValidUsername(`た ${mark}${voicing}いき`)).toBe(false);
      expect(isValidUsername(`た ${voicing}${mark}いき`)).toBe(false);
      expect(nameKey(`た ${mark}${voicing}いき`)).toBe(nameKey("だいき"));
      expect(nameKey(`た ${voicing}${mark}いき`)).toBe(nameKey("だいき"));
    }
  });

  it.each([
    ["dot below", "\u0323"],
    ["acute", "\u0301"],
  ])("after a letter that doesn't take it, another mark (%s) and a voicing mark on a space key alike in either order", (_label, mark) => {
    for (const voicing of [DAKUTEN, HALFWIDTH_DAKUTEN]) {
      expect(isValidUsername(`a ${mark}${voicing}b`)).toBe(true);
      expect(nameKey(`a ${mark}${voicing}b`)).toBe(nameKey(`a ${voicing}${mark}b`));
      expect(visualKey(`a ${mark}${voicing}b`)).toBe(visualKey(`a ${voicing}${mark}b`));
    }
  });

  // A spacing mark typed after a space leaves a gap before it: a different name from the voiced kana, but one that
  // looks like it, as do the other spellings of the mark after a space
  it.each([
    [`た ${SPACING_DAKUTEN}いき`, "だいき", `た ${HALFWIDTH_DAKUTEN}いき`],
    [`は ${SPACING_HANDAKUTEN}な`, "ぱな", `は ${HANDAKUTEN}な`],
    [`ﾀ ${SPACING_DAKUTEN}ｲｷ`, "ﾀﾞｲｷ", `ﾀ ${HALFWIDTH_DAKUTEN}ｲｷ`],
  ])("%j looks like %j and %j without being the same name", (spaced, voiced, otherSpelling) => {
    expect(isValidUsername(spaced)).toBe(true);
    expect(looksLike(spaced, voiced)).toBe(true);
    expect(sameName(spaced, voiced)).toBe(false);
    expect(looksLike(spaced, otherSpelling)).toBe(true);
  });
});
