import { describe, expect, it } from "vitest";
import { displayOrder } from "../managers/displayOrder";

// EXP-032: names are compared in the order they are drawn too, where right-to-left letters run reversed.
// Hebrew alef, bet and gimel (U+05D0-05D2) stand for any right-to-left letter.
const ALEF = "א";
const BET = "ב";
const GIMEL = "ג";

describe("displayOrder", () => {
  it.each([
    ["no right-to-left letter", "bob", "bob"],
    ["kaomoji", "(ノಠ益ಠ)ノ", "(ノಠ益ಠ)ノ"],
    ["two emoji", "\u{1F600}\u{1F601}", "\u{1F600}\u{1F601}"],
    ["emoji between Latin letters", "a\u{1F600}\u{1F601}b", "a\u{1F600}\u{1F601}b"],
    ["math bold letters", "\u{1D401}\u{1D428}\u{1D41B}", "\u{1D401}\u{1D428}\u{1D41B}"],
    ["right-to-left run after Latin", `Mi${ALEF}${BET}`, `Mi${BET}${ALEF}`],
    ["right-to-left run after math bold letters", `\u{1D40C}\u{1D422}${ALEF}${BET}`, `\u{1D40C}\u{1D422}${BET}${ALEF}`],
    ["marks and joiners stay on their letter", "aه‌ا", "aاه‌"],
    ["a mark stays on its right-to-left letter", `Leo ${ALEF}${BET}ֹ`, `Leo ${BET}ֹ${ALEF}`],
    ["digits between right-to-left letters keep their order",
      `ab ${ALEF}${BET} 12 ${GIMEL}`, `ab ${GIMEL} 12 ${BET}${ALEF}`],
    ["right-to-left paragraph", `${ALEF}${BET} cd`, `cd ${BET}${ALEF}`],
    ["right-to-left paragraph with numbers", `${ALEF} 12 cd 34`, `cd 34 12 ${ALEF}`],
    ["a decimal number stays whole", `${ALEF} 1.2`, `1.2 ${ALEF}`],
    ["Arabic-Indic digits after Latin join the right-to-left run", `x ١٢ ${ALEF}`, `x ${ALEF} ١٢`],
    ["Arabic-Indic digit before a right-to-left letter", `Mi٥${ALEF}`, `Mi${ALEF}٥`],
    ["brackets in a right-to-left run are mirrored", `(${ALEF}${BET}l`, `l${BET}${ALEF})`],
    ["characters outside the BMP (Adlam) stay whole", "ab\u{1E900}\u{1E901}", "ab\u{1E901}\u{1E900}"],
  ])("%s", (_label, stored, drawn) => {
    expect(displayOrder(stored)).toBe(drawn);
  });
});

// ── Properties over random names ──
// Each token is a base character with an optional mark and an optional joiner, so the clusters of the result are
// exactly the clusters of the name in another order (a joiner never follows an emoji, a mark never starts a name).

const BASES = [
  ..."abMo019 ()[]<>{}.-",
  "א", "ס", "ו", "ا", "ه", "ل", "ߋ", "ߕ", // Hebrew, Arabic, NKo
  "١", "٥", "۵", // Arabic-Indic and extended Arabic-Indic digits
  "\u{1D7CE}", "\u{1D401}", "\u{1E900}", "\u{10C80}", "\u{1F600}", "\u{1F525}", // math digit and letter, Adlam,
  // Old Hungarian, emoji
];
const LETTERS = new Set(["a", "b", "M", "o", "א", "ס", "ו", "ا", "ه", "ل", "ߋ"]);
const MARKS = ["́", "ֹ", "ّ", "̀"];
const JOINERS = ["‌", "‍"];
const MIRRORED: Record<string, string> = { ")": "(", "]": "[", ">": "<", "}": "{" };
const NAMES = 400;
const MAX_TOKENS = 12;

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), so a failure always reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomName(random: () => number): string {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  return Array.from({ length: 1 + Math.floor(random() * MAX_TOKENS) }, () => {
    const base = pick(BASES);
    if (!LETTERS.has(base)) return base;
    return base + (random() < 0.3 ? pick(MARKS) : "") + (random() < 0.2 ? pick(JOINERS) : "");
  }).join("");
}

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
/** The grapheme clusters of `text`, sorted, with mirrored brackets read as their opening form. */
const clusterMultiset = (text: string) =>
  Array.from(segmenter.segment(text), ({ segment }) => MIRRORED[segment] ?? segment).sort();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("displayOrder on random names", () => {
  const random = seededRandom(32);
  const names = Array.from({ length: NAMES }, () => randomName(random));

  it(`${NAMES} names stay well-formed and keep their grapheme clusters`, () => {
    for (const name of names) {
      const drawn = displayOrder(name);
      expect(LONE_SURROGATE.test(drawn), `lone surrogate in ${JSON.stringify(drawn)}`).toBe(false);
      expect(clusterMultiset(drawn), `clusters of ${JSON.stringify(name)}`).toEqual(clusterMultiset(name));
    }
  });
});
