import { ASCII_CONFUSABLES } from "./asciiConfusables";
import { displayOrder } from "./displayOrder";

/**
 * Player names (EXP-032): which names are accepted, and when two names count as the same one in a room.
 *
 * Players may use any script, emoji, symbols or ASCII art ("¯\_(ツ)_/¯", "(•_•)", "<3 <3"). A name is stored and shown
 * exactly as the player typed it (the app compares its own typed name with the names the server sends, so the server
 * never rewrites it). Impersonation is stopped by two rules instead:
 * - names with invisible characters, unusual spaces, piles of combining marks or letters from two scripts that can be
 *   drawn like Latin are refused (isValidUsername);
 * - two names that read alike, in stored or on-screen order, share a `nameKey` (the same name) or at least a
 *   `visualKey` (too similar), and a room never holds two such players (nameKeys, nameClash).
 */

export const MAX_USERNAME_LENGTH = 20;
// NFKC can expand one character a lot (the Arabic ligature U+FDFA is 18 letters): bounds the work of the name keys
const MAX_NORMALIZED_LENGTH = 60;

// ── Validation ──────────────────────────────────────

// Pieces that only make sense inside an emoji: the zero-width joiner of a sequence (woman technologist, rainbow flag),
// the selectors that ask for emoji or text presentation (red heart, keycap one) and the tag letters of a subdivision
// flag (black flag + tags + cancel tag, e.g. England). Allowed there; anywhere else they are invisible characters.
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}\p{Emoji_Modifier}?\uFE0F?)\u200D(?=\p{Extended_Pictographic})/gu;
const EMOJI_PRESENTATION = /(?<=[\p{Extended_Pictographic}#*0-9])[\uFE0E\uFE0F]/gu;
const EMOJI_TAG_SEQUENCE = /(?<=\u{1F3F4})[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
// Scripts whose spelling needs a zero-width joiner or non-joiner between letters (the Sinhala "Sri" conjunct, the
// Persian half-space, Devanagari half forms). Allowed between two letters of these scripts; anywhere else they are
// invisible characters. Script lists here only name scripts of Unicode 15.1 or older (Node 20's ICU): their regexes are
// built when the module loads, and an unknown name would stop the server (see tests/playerNameScripts.test.ts).
export const JOINER_SCRIPTS = [
  "Arabic", "Syriac", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada",
  "Malayalam", "Sinhala",
];
const JOINER_SCRIPT_CLASS = JOINER_SCRIPTS.map((name) => `\\p{Script_Extensions=${name}}`).join("");
const JOINER_SCRIPT_LETTER = `[\\p{L}&&[${JOINER_SCRIPT_CLASS}]]`;
const SCRIPT_JOINER = new RegExp(
  `(?<=${JOINER_SCRIPT_LETTER}\\p{M}*)[\\u200C\\u200D](?=${JOINER_SCRIPT_LETTER})`,
  "gv",
);

// Controls, format characters (zero-width, bidi overrides, BOM, tags), private-use/unassigned/surrogate code points,
// line/paragraph separators, default-ignorable characters (fillers, variation selectors, combining grapheme joiner),
// characters drawn blank (braille blank, Khitan filler, musical null notehead, object replacement) and every space
// other than the plain one (no-break, ideographic, en/em spaces...).
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u{16FE4}\u{1D159}\uFFFC]|(?!\u0020)\p{Zs}/u;
// A combining mark at the start (after any leading spaces) would draw over whatever the app shows before the name
const LEADING_MARK = /^\u0020*\p{M}/u;
// A combining mark on a space at the end draws next to the name without changing how it reads ("bob" + space + dot)
const TRAILING_MARK = /\u0020\p{M}+\u0020*$/u;
// Real spellings stack up to three or four marks on a letter (Tibetan, pointed Hebrew); more is "Zalgo" text
const MAX_MARKS_IN_A_ROW = 4;
const MARK_PILE = new RegExp(`\\p{M}{${MAX_MARKS_IN_A_ROW + 1},}`, "u");

/** `text` without the format characters allowed where they belong (inside an emoji, between joining letters). */
const withoutAllowedFormatChars = (text: string) => text
  .replace(EMOJI_JOINER, "")
  .replace(EMOJI_PRESENTATION, "")
  .replace(EMOJI_TAG_SEQUENCE, "")
  .replace(SCRIPT_JOINER, "");

/**
 * A name the server accepts: a string of 1–20 UTF-16 units (at most 60 after NFKC), not blank, with no invisible
 * characters or spaces other than U+0020, no combining mark at the start or on a trailing space, at most four
 * combining marks in a row and no mix of Latin-lookalike scripts (see mixesLookalikeScripts). Emoji, symbols,
 * punctuation and digits are free: a name may be made only of them.
 */
export function isValidUsername(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_USERNAME_LENGTH) return false;
  if (value.normalize("NFKC").length > MAX_NORMALIZED_LENGTH) return false;
  return !INVISIBLE.test(withoutAllowedFormatChars(value))
    && !LEADING_MARK.test(value)
    && !TRAILING_MARK.test(value)
    && !MARK_PILE.test(value)
    && !mixesLookalikeScripts(value);
}

// ── Scripts ─────────────────────────────────────────

// Scripts that spell whole Latin lookalikes ("bоb" with a Cyrillic o, "Daνe" with a Greek nu): UTS #39 "Moderately
// Restrictive" keeps Latin apart from Greek and Cyrillic, and Armenian, Cherokee, Lisu and Coptic are as close. Any
// other mix is free ("Li 李", "Ahmed أحمد", kaomoji such as "(ノಠ益ಠ)ノ"): a lookalike of a player's name is still caught
// by the room's name keys. Unicode 15.1 or older, as JOINER_SCRIPTS.
export const LATIN_LOOKALIKE_SCRIPTS = ["Latin", "Greek", "Cyrillic", "Armenian", "Cherokee", "Lisu", "Coptic"];
const LOOKALIKE_SCRIPT_PATTERNS = LATIN_LOOKALIKE_SCRIPTS.map((name) => ({
  name,
  pattern: new RegExp(`^\\p{Script=${name}}$`, "u"),
}));
const LATIN_LETTER = /^\p{Script=Latin}$/u;
const LETTER = /\p{L}/gu;
const ANY_MARK = /\p{M}/gu;

/** Latin letters, and other letters only when drawn like ASCII (Greek nu yes; Greek sigma, Cyrillic zhe no). */
const readsAsLatin = (letter: string) => LATIN_LETTER.test(letter) || letter in ASCII_CONFUSABLES;

const lookalikeScriptOf = (letter: string) =>
  LOOKALIKE_SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(letter))?.name;

/**
 * Letters that read as Latin from two of the Latin-lookalike scripts (e.g. Latin with a Greek nu or an Armenian oh,
 * Greek alpha with Cyrillic be), accents dropped first ("Dάve" has a Greek alpha). Digits, symbols, emoji and other
 * letters don't count: "Dave Ж", "Σ(ﾟДﾟ)".
 */
function mixesLookalikeScripts(name: string): boolean {
  const bare = name.normalize("NFKC").normalize("NFD").replace(ANY_MARK, "");
  const letters = (bare.match(LETTER) ?? []).filter(readsAsLatin);
  return new Set(letters.map(lookalikeScriptOf).filter(Boolean)).size > 1;
}

// ── Lookalike keys ──────────────────────────────────

// Marks on a letter or symbol. A mark on a space stays: NFKC turns spacing accents (the arms of "¯\_(ツ)_/¯", ´, ¨)
// into a space plus a mark, and that mark is all they draw
const COMBINING_MARK = /(?<!\s)\p{Mn}/gu;
// Joiners and subdivision tags an accepted name may still carry (variation selectors go with the marks)
const IGNORABLE_IN_KEY = /[\u200C\u200D\u{E0020}-\u{E007F}]/gu;
const WHITESPACE_RUN = /\s+/gu;
// Visual key only: letters and digits that differ in some fonts, at the small sizes the app draws names
const LOOKS_LIKE_L = /[Il|1]/g;
const VISUAL_LOOKALIKES: ReadonlyArray<[RegExp, string]> = [[/rn/g, "m"], [/vv/g, "w"], [/cl/g, "d"], [/0/g, "o"]];

/** Each character drawn like ASCII letters or digits replaced by them (UTS #39 table, see asciiConfusables.ts). */
const toAscii = (text: string) => Array.from(text, (char) => ASCII_CONFUSABLES[char] ?? char).join("");

/** Upper then lower approximates Unicode case folding (sharp s to "ss", final sigma to sigma), unlike toLowerCase. */
const foldCase = (text: string) => text.toUpperCase().toLowerCase();

/**
 * Lookalikes read as ASCII (case kept: Greek small nu reads as "v" but capital nu as "N"), then NFKC (full-width,
 * styled letters), accents and other combining marks on a letter or symbol dropped, the table again for what NFKC and
 * the marks uncovered, joiners dropped, whitespace trimmed and collapsed. The table runs before NFKC too because NFKC
 * can lose the look: long s reads as "f" but NFKC turns it into "s".
 */
function skeleton(name: string): string {
  const bare = toAscii(name).normalize("NFKC").normalize("NFD").replace(COMBINING_MARK, "").normalize("NFC");
  return toAscii(bare).replace(IGNORABLE_IN_KEY, "").replace(WHITESPACE_RUN, " ").trim();
}

/**
 * Comparison key of a name: its case-folded skeleton. "bob", "Bob ", full-width "bob", "bob" with a dot below, "dave"
 * in Latin small capitals, Cherokee letters drawn like "DAVE", "Pa∪l" (union sign) or "A│ice" (box drawing) share a
 * key with their plain spelling. The table runs again after folding for the lowercase forms of letters only listed in
 * uppercase.
 */
export function nameKey(name: string): string {
  return toAscii(foldCase(skeleton(name)));
}

/**
 * Looser key for letter groups that only differ in some fonts: I / l / | / 1 read as "l", then "rn" as "m", "vv" as
 * "w", "cl" as "d" and 0 as "o" ("AIice" reads as "Alice", "rnike" as "mike").
 */
export function visualKey(name: string): string {
  const folded = toAscii(foldCase(skeleton(name).replace(LOOKS_LIKE_L, "l")));
  return VISUAL_LOOKALIKES.reduce((key, [pattern, replacement]) => key.replace(pattern, replacement), folded);
}

// ── Comparing names ─────────────────────────────────

/** The two keys of a name read in one order. */
interface OrderKeys {
  readonly same: string;
  readonly visual: string;
}

/** The keys of a name as stored and as drawn on screen (right-to-left letters reversed, see displayOrder). */
export interface NameKeys {
  readonly stored: OrderKeys;
  readonly drawn: OrderKeys;
}

/** How a name compares with another: the same name, a different one that looks too alike, or distinct. */
export type NameClash = "same" | "similar" | null;

const orderKeys = (text: string): OrderKeys => ({ same: nameKey(text), visual: visualKey(text) });

/** Keys of `name` (compute once per player: see RoomManager). */
export function nameKeys(name: string): NameKeys {
  return { stored: orderKeys(name), drawn: orderKeys(displayOrder(name)) };
}

/**
 * "same" when the names share a nameKey ("bob" and "Bob ", "bob" with a Cyrillic o, "Milo" and "Mi" + Hebrew samekh
 * and vav, which draw as "lo"); "similar" when they only share a visualKey ("Alice" and "AIice", "Clara" and "Dara").
 * Stored order is compared with stored order and drawn with drawn, so a right-to-left name never meets its reversal.
 */
export function nameClash(a: NameKeys, b: NameKeys): NameClash {
  const matches = (key: keyof OrderKeys) => a.stored[key] === b.stored[key] || a.drawn[key] === b.drawn[key];
  if (matches("same")) return "same";
  return matches("visual") ? "similar" : null;
}

/** Whether two names are the same name (nameClash "same"). */
export function sameName(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) === "same";
}

/** Whether two names would read alike on screen (the same name or too similar). */
export function looksLike(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) !== null;
}
