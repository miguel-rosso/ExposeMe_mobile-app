import bidiFactory, { BidiCharTypeName } from "bidi-js";

/**
 * The order in which a player name is drawn on screen, left to right (EXP-032). Letters of right-to-left scripts are
 * stored in reading order but drawn reversed, so "Mi" followed by Hebrew samekh and vav (drawn like "o" and "l") is
 * stored as "Miol" but reads "Milo". Runs the Unicode Bidirectional Algorithm (UAX #9, bidi-js) with the paragraph
 * direction taken from the first strong character, as the app's text views do, moves whole grapheme clusters (a
 * letter keeps its marks and joiners, an emoji or a character outside the BMP stays in one piece) and mirrors
 * brackets inside right-to-left runs.
 */

const bidi = bidiFactory();
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

// Classes that can make text run right to left: right-to-left letters and Arabic numbers
const REORDERING_CLASSES: ReadonlySet<BidiCharTypeName> = new Set(["R", "AL", "AN"]);

// bidi-js reads one UTF-16 unit at a time, so a character outside the BMP (Adlam, Old Hungarian...) would count as
// left-to-right. For the levels only, each one is replaced by two BMP characters of its bidi class.
const BMP_STAND_INS: Partial<Record<BidiCharTypeName, string>> = {
  L: "a", R: "א", AL: "ا", EN: "0", AN: "٠", ES: "+", ET: "#", CS: ",", NSM: "̀", WS: " ",
};
// Valid names hold no controls or separators, so any other class is a neutral
const NEUTRAL_STAND_IN = "!";
const ASTRAL_CHAR = /[\u{10000}-\u{10FFFF}]/gu;

const withBmpStandIns = (text: string) =>
  text.replace(ASTRAL_CHAR, (char) => (BMP_STAND_INS[bidi.getBidiCharTypeName(char)] ?? NEUTRAL_STAND_IN).repeat(2));

const canReorder = (text: string) =>
  Array.from(text).some((char) => REORDERING_CLASSES.has(bidi.getBidiCharTypeName(char)));

/** `cluster` with its base character mirrored ("(" drawn as ")") when it sits in a right-to-left run. */
function mirrored(cluster: string, level: number): string {
  if (level % 2 === 0) return cluster;
  const [base] = Array.from(cluster);
  const mirror = bidi.getMirroredCharacter(base);
  return mirror ? mirror + cluster.slice(base.length) : cluster;
}

/** `text` as drawn on screen from left to right; unchanged when nothing in it runs right to left. */
export function displayOrder(text: string): string {
  if (!canReorder(text)) return text;
  const typed = withBmpStandIns(text);
  const embedding = bidi.getEmbeddingLevels(typed, "auto");
  // One slot per UTF-16 unit, as bidi-js counts: each cluster sits in the slot of its first unit, the rest stay empty
  const slots = new Array<string>(text.length).fill("");
  for (const { segment, index } of graphemes.segment(text)) slots[index] = mirrored(segment, embedding.levels[index]);
  for (const [start, end] of bidi.getReorderSegments(typed, embedding)) {
    slots.splice(start, end - start + 1, ...slots.slice(start, end + 1).reverse());
  }
  return slots.join("");
}
