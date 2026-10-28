import { existsSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { SYMBOL_CONFUSABLES } from "../managers/asciiConfusables";
import { isValidUsername, looksLike, sameName } from "../managers/playerName";

// EXP-268: symbols drawn like other symbols of the same size (UTS #39 confusables with a symbol prototype) meet in the
// visual key ("Username too similar"); a clearly different size, colour or a real word stays a different name
// (DEC-033).
// Every non-ASCII character is written as an escape on purpose.

const SHRUG = "\u00AF\\_(\u30C4)_/\u00AF";

describe("symbol lookalikes", () => {
  it.each([
    ["bullet operator and bullet", "(\u2219_\u2219)", "(\u2022_\u2022)"],
    ["retroflex clicks as exclamation marks", "!!", "\u01C3\u01C3"],
    ["glottal stop as a question mark", "??", "\u0294\u0294"],
    ["minus sign as an en dash", "(\u2013_\u2013)", "(\u2212_\u2212)"],
    ["em dash and horizontal bar", "(\u2014_\u2014)", "(\u2015_\u2015)"],
    ["em dash and prolonged sound mark", "(\u2014_\u2014)", "(\u30FC_\u30FC)"],
    ["Han one as a prolonged sound mark", "(\u30FC_\u30FC)", "(\u4E00_\u4E00)"],
    ["Hangul eu as a prolonged sound mark", "(\u30FC_\u30FC)", "(\u3161_\u3161)"],
    ["Arabic tatweel as a low line", "(o_o)", "(o\u0640o)"],
    ["curly apostrophe", "it's me", "it\u2019s me"],
    ["acute accent as an apostrophe (before NFKC makes it a mark)", "it's", "it\u00B4s"],
    ["curly double quotes as two apostrophes", "\"yo\"", "\u201Cyo\u201D"],
    ["grave accent as an apostrophe", "`hi`", "'hi'"],
    ["saltillo in either case", "''", "\uA78B\uA78C"],
    ["cedilla as a comma (before NFKC makes it a mark)", "x,x", "x\u00B8x"],
    ["ornament parentheses", "(\u2022_\u2022)", "\u2768\u2022_\u2022\u2769"],
    ["tortoise shell brackets", "(^_^)", "\u3014^_^\u3015"],
    ["modifier macron arms", SHRUG, "\u02C9\\_(\u30C4)_/\u02C9"],
    ["overline arms", SHRUG, "\u203E\\_(\u30C4)_/\u203E"],
    ["ring above as a degree sign", "(\u00B0_\u00B0)", "(\u02DA_\u02DA)"],
    ["masculine ordinal as a degree sign", "(\u00B0_\u00B0)", "(\u00BA_\u00BA)"],
    ["superscript zero as a degree sign", "(\u00B0_\u00B0)", "(\u2070_\u2070)"],
    ["symbols read in drawn order", "\u05D0 (\u2022)", "\u05D0 (\u2219)"],
  ])("%s: %j and %j look alike without being the same name", (_label, a, b) => {
    expect(looksLike(a, b)).toBe(true);
    expect(sameName(a, b)).toBe(false);
  });

  it.each([
    // Different symbols
    ["(\u2022_\u2022)", "(\u00B0_\u00B0)"],
    ["(\u2022_\u2022)", "(^_^)"],
    ["(\u2022_\u2022)", "(\u0CA0_\u0CA0)"],
    ["(-_-)", "(\u2014_\u2014)"],
    ["(-_-)", "(=_=)"],
    [SHRUG, "\u00AF\\_(\u2022)_/\u00AF"],
    ["!!", "!?"],
    ["<3", "\u2661"],
    // Colour emoji differ by colour
    ["\u{1F34E}", "\u{1F34F}"],
    ["\u{1F312}", "\u{1F319}"],
    // Indic and Khmer vowel signs are letters of a word
    ["\u0921\u0949\u0932\u0940", "\u0921\u093E\u0932\u0940"],
    ["\u0C38\u0C42\u0C30\u0C4D\u0C2F", "\u0C38\u0C41\u0C30\u0C4D\u0C2F"],
    ["\u0D15\u0D3F\u0D33\u0D3F", "\u0D15\u0D40\u0D33\u0D3F"],
    ["\u1790\u17BE\u1794", "\u1790\u17C1\u1794"],
    // Symbols drawn like letters of different case: case folding must not join them
    ["\u2211", "\u222B"],
    ["\u2200", "\u0250"],
    ["\u2203", "\u01DD"],
    ["\u2630", "\u03BE"],
    ["\u0241\u0241", "??"],
    ["\u0242\u0242", "??"],
    // A clearly different size (measured in Roboto and SF)
    ["(\u30FB_\u30FB)", "(\u2022_\u2022)"],
    ["\u0295\u2022\u1D25\u2022\u0294", "\u0295\u00B7\u1D25\u00B7\u0294"],
    ["\u2588\u2580\u2588", "\u25A0\u2580\u25A0"],
    ["\u25AA", "\u220E"],
    ["(\u256F\u00B0\u25A1\u00B0)\u256F", "(\u256F\u25CB\u25A1\u25CB)\u256F"],
    ["(\u00B0_\u00B0)", "(\u25E6_\u25E6)"],
    ["(\u00B0_\u00B0)", "(\u2218_\u2218)"],
    ["(\u00B0_\u00B0)", "(\u26AC_\u26AC)"],
    ["(-_-)", "(\u2013_\u2013)"],
    ["(\u30FC_\u30FC)", "(\uFF0D_\uFF0D)"],
    ["\u2500\u2500", "\u2501\u2501"],
    ["~", "\u02DC"],
  ])("different symbols %j and %j stay distinct", (a, b) => {
    expect(looksLike(a, b)).toBe(false);
  });

  it("every entry of the symbol table looks like its prototype typed as is", () => {
    const entries = [...SYMBOL_CONFUSABLES];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter(([source, prototype]) => !looksLike(`x${source}x`, `x${prototype}x`))).toEqual([]);
  });
});

// ── Sweep over confusables.txt ──────────────────────

// Runs when Unicode's confusables.txt is at CONFUSABLES_TXT (default /tmp/confusables.txt); it stays out of the repo:
//   curl -o /tmp/confusables.txt https://www.unicode.org/Public/security/latest/confusables.txt
const CONFUSABLES_TXT = process.env.CONFUSABLES_TXT ?? "/tmp/confusables.txt";
const ENTRY = /^([0-9A-F]+) ;\t([0-9A-F ]+) ;\tMA\t/;
const fromHex = (hex: string) => String.fromCodePoint(...hex.trim().split(" ").map((code) => parseInt(code, 16)));
const WORD_CHARACTER = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]/u;
const SYMBOL = /[\p{P}\p{S}]/u;
const isCased = (text: string) => text.toLowerCase() !== text.toUpperCase();

// Sources the generator keeps apart on purpose (see SIZE_PROTOTYPES in scripts/generateAsciiConfusables.mjs)
const OTHER_SIZE = new Set([
  "\u2022", "\u2219", "\u30FB", "\uFF65", "\u25CB", "\uFFEE", "\u26AC", "\u25E6", "\u2218", "\u2588", "\u25A0",
  "\uFFED", "\u25AA", "\u2013", "\u2212", "\u2012", "\u2501", "\uFF0D", "\u2594", "\u02DC", "\u301C",
]);
// Characters of symbol entries that Unicode 16 or 17 added: the generator runs on Node 20 (Unicode 15.1, the oldest the
// server supports) and leaves them out. Newer Nodes know them, so they are listed here
const NEWER_THAN_UNICODE_15_1 = new Set([
  0x208F, 0x2E62, 0x2E63, 0x11DD9, 0x12562, 0x16FF3, 0x1CCFB, 0x1CEE0, 0x1CEEF, 0x1CEF0, 0x1E5FF, 0x1E6E9,
  0x1F8D0, 0x1F8D1, 0x1FA55, 0x1FA57,
]);

/** Why the visual key may tell a symbol entry apart from its prototype, or null when it must not. */
function exclusion(source: string, prototype: string): string | null {
  if (/\p{M}/u.test(source)) return "marks are letters of a word (Indic vowel signs) or drop with the skeleton";
  if (/(?![\0-\x7F])\p{Emoji}/u.test(source)) return "emoji may be drawn in colour";
  if (!isValidUsername(`x${source}x`)) return "refused in names (spaces, blank characters)";
  if (/\p{Cn}/u.test(source + prototype)
    || [...source + prototype].some((char) => NEWER_THAN_UNICODE_15_1.has(char.codePointAt(0)!))) {
    return "newer than Unicode 15.1";
  }
  if (/\p{Mn}/u.test(prototype.normalize("NFKC"))) return "the skeleton drops the prototype's marks";
  if (isCased(prototype)) return "case folding would join symbols drawn like different letters";
  const otherCase = source.toLowerCase() === source ? source.toUpperCase() : source.toLowerCase();
  if (isCased(source) && !looksLike(`x${otherCase}x`, `x${prototype}x`)) return "its other case reads differently";
  if (OTHER_SIZE.has(source)) return "clearly different size";
  return null;
}

describe.runIf(existsSync(CONFUSABLES_TXT))("symbol entries of confusables.txt", () => {
  it("each looks like its prototype unless excluded for a stated reason", () => {
    const entries = readFileSync(CONFUSABLES_TXT, "utf8").split("\n").flatMap((line) => {
      const match = line.match(ENTRY);
      return match ? [{ source: fromHex(match[1]), prototype: fromHex(match[2]) }] : [];
    });
    const symbolEntries = entries.filter(({ source, prototype }) => SYMBOL.test(source)
      || !WORD_CHARACTER.test(prototype.normalize("NFKC")));
    expect(symbolEntries.length).toBeGreaterThan(500);
    const missed = symbolEntries.filter(({ source, prototype }) => exclusion(source, prototype) === null
      && !looksLike(`x${source}x`, `x${prototype}x`));
    expect(missed.map(({ source, prototype }) => `${source} \u2192 ${prototype}`)).toEqual([]);
  });
});
