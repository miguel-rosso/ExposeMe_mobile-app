import { describe, expect, it } from "vitest";
import { SYMBOL_CONFUSABLES } from "../managers/asciiConfusables";
import { isValidUsername, looksLike, sameName } from "../managers/playerName";

// EXP-321: ideographs UTS #39 draws alike (simplified, traditional and Japanese forms of one character, near twins)
// read as one another in the visual key ("Username too similar"), unless one is clearly bigger. Each pair stays a
// different name (nameKey): the glyphs differ a little.
// Ideographs are written as escapes on purpose: in source they are as hard to tell apart as on screen.

const RICE_FIELD = "\u7530";
const BRIGHT = "\u660E";

describe("ideograph lookalikes", () => {
  it.each([
    ["enclosure and mouth", `\u56D7${RICE_FIELD}`, `\u53E3${RICE_FIELD}`],
    ["simplified and traditional Wu", `\u5434${BRIGHT}`, `\u5433${BRIGHT}`],
    ["Japanese and traditional Wu", `\u5449${BRIGHT}`, `\u5433${BRIGHT}`],
    ["simplified and Japanese Wu", `\u5434${BRIGHT}`, `\u5449${BRIGHT}`],
    ["simplified and traditional dui", "\u5151", "\u514C"],
    ["Chinese and Japanese zhi", "\u503C", "\u5024"],
    ["water and ice radical cou", "\u6E4A", "\u51D1"],
    ["scholar and earth", `\u58EB${RICE_FIELD}`, `\u571F${RICE_FIELD}`],
    ["say and sun", "\u66F0\u5411", "\u65E5\u5411"],
  ])("%s look alike, either way round, without being the same name", (_label, a, b) => {
    expect(isValidUsername(a) && isValidUsername(b)).toBe(true);
    expect(looksLike(a, b)).toBe(true);
    expect(looksLike(b, a)).toBe(true);
    expect(sameName(a, b)).toBe(false);
  });

  it.each([
    // The grass radical is a flat top part, half the height of the ideographs drawn like it
    ["twenty and the grass radical", "\u5344", "\u8279"],
    ["U+535D and the grass radical", "\u535D", "\u8279"],
    // Different names stay apart
    ["Yamada and Kuchida", `\u5C71${RICE_FIELD}`, `\u53E3${RICE_FIELD}`],
    ["Jiro and Niro", "\u6B21\u90CE", "\u4E8C\u90CE"],
    // Later extensions are left out (UTS #39 draws U+2011E like two)
    ["two and Extension B 2011E", "\u4E8C", "\u{2011E}"],
  ])("%s stay distinct", (_label, a, b) => {
    expect(looksLike(a, b)).toBe(false);
  });

  it("every ideograph entry of the symbol table looks like its prototype in a name", () => {
    const ideograph = /^[\u3400-\u4DBF\u4E00-\u9FFF]$/u;
    const entries = [...SYMBOL_CONFUSABLES]
      .filter(([source, prototype]) => ideograph.test(source) && ideograph.test(prototype));
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.filter(([source, prototype]) => !looksLike(`${source}${RICE_FIELD}`, `${prototype}${RICE_FIELD}`)))
      .toEqual([]);
  });
});
