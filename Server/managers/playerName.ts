import {
  ASCII_CONFUSABLES, EXTENDED_PICTOGRAPHIC_RANGES, INDIC_CONFUSABLES, SYMBOL_CONFUSABLES, UNASSIGNED_EMOJI_RANGES,
  UNASSIGNED_NON_EMOJI_RANGES,
} from "./asciiConfusables";
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
 *   `visualKey` or `letterVisualKey` (too similar), and a room never holds two such players (nameKeys, nameClash).
 */

// Longest name in UTF-16 units: exactly what the app's name input takes (MAX_USERNAME_INPUT_LENGTH in
// Client/app/utils/protocolLimits.ts; qa/lab/tests/protocol-constants.test.sh checks they are equal)
export const MAX_USERNAME_LENGTH = 15;
// NFKC can expand one character a lot (the Arabic ligature U+FDFA is 18 letters): bounds the work of the name keys
const MAX_NORMALIZED_LENGTH = 60;

// ── Validation ──────────────────────────────────────

/** A regex character class matching the [first, last] code point `ranges`. */
const codePointClass = (ranges: ReadonlyArray<readonly [number, number]>) =>
  `[${ranges.map(([first, last]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`).join("")}]`;

// Emoji, assigned or reserved, of Unicode 15.1 (Extended_Pictographic, a fixed list): Unicode 17 took 689 code points
// out of the property, so the running Node's \p{Extended_Pictographic} would accept "★" + emoji selector on Node 20
// and refuse it on Node 24
const EMOJI = codePointClass(EXTENDED_PICTOGRAPHIC_RANGES);
// Pieces that only make sense inside an emoji: the zero-width joiner of a sequence (woman technologist, rainbow flag),
// the selectors that ask for emoji or text presentation (red heart, keycap one) and the tag letters of a subdivision
// flag (black flag + tags + cancel tag, e.g. England). Allowed there; anywhere else they are invisible characters.
const EMOJI_JOINER = new RegExp(`(?<=${EMOJI}\\p{Emoji_Modifier}?\\uFE0F?)\\u200D(?=${EMOJI})`, "gu");
const EMOJI_PRESENTATION = new RegExp(`(?<=${EMOJI}|[#*0-9])[\\uFE0E\\uFE0F]`, "gu");
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

// Controls, format characters (zero-width, bidi overrides, BOM, tags), private-use/surrogate code points,
// line/paragraph separators, default-ignorable characters (fillers, variation selectors, combining grapheme joiner),
// characters drawn blank (braille blank, Khitan filler, musical null notehead, object replacement) and every space
// other than the plain one (no-break, ideographic, en/em spaces...). Unassigned code points: UNASSIGNED_IN_TABLES.
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u{16FE4}\u{1D159}\uFFFC]|(?!\u0020)\p{Zs}/u;
// Code points unassigned in the Unicode version of the lookalike tables (15.1, see asciiConfusables.ts), also those a
// newer Node knows (EXP-284): the tables don't, so a letter added since could be drawn like another one without
// sharing its keys. Not those Unicode 15.1 reserves for emoji, which the tables leave out anyway (drawn in colour):
// newer emoji are fine. A fixed list rather than the running Node's categories, so every Node accepts the same names
const UNASSIGNED_IN_TABLES = new RegExp(codePointClass(UNASSIGNED_NON_EMOJI_RANGES), "u");
// A space at either end or two in a row: the app never sends them (it trims the name and collapses its spaces,
// EXP-263), and since the name is shown as typed everyone would see it padded or split (EXP-327)
const STRAY_SPACES = /^\u0020|\u0020$|\u0020\u0020/u;
// A combining mark at the start would draw over whatever the app shows before the name
const LEADING_MARK = /^\p{M}/u;
// A combining mark on a space at the end draws next to the name without changing how it reads ("bob" + space + dot)
const TRAILING_MARK = /\u0020\p{M}+$/u;
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
 * A name the server accepts: a string of 1–15 UTF-16 units (at most 60 after NFKC), not blank, with no invisible
 * characters, characters the lookalike tables don't know (unassigned in their Unicode 15.1; newer emoji are fine, and
 * read alike by visualKey) or spaces other than U+0020, no space at either end or two in a row, no combining mark at
 * the start or on a trailing space, at most four combining marks in a row, no mark on a kana with a voiced form but
 * the voicing mark it takes (marksKanaOddly), no mix of Latin-lookalike scripts (see mixesLookalikeScripts), no Hangul
 * block of jamo that don't make one syllable (splitsHangulBlock), no vowel sign or virama on an Indic independent vowel
 * (marksIndependentVowelOddly) and no Indic vowel sign but one on a letter of its script, which carries only marks of
 * that script, no length mark left alone and no rare mark hiding a vowel sign (marksIndicLetterOddly). Emoji, symbols,
 * punctuation and digits are free: a name may be made only of them.
 */
export function isValidUsername(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_USERNAME_LENGTH) return false;
  if (value.normalize("NFKC").length > MAX_NORMALIZED_LENGTH) return false;
  return !STRAY_SPACES.test(value)
    && !INVISIBLE.test(withoutAllowedFormatChars(value))
    && !UNASSIGNED_IN_TABLES.test(value)
    && !LEADING_MARK.test(value)
    && !TRAILING_MARK.test(value)
    && !MARK_PILE.test(value)
    && !marksKanaOddly(value)
    && !mixesLookalikeScripts(value)
    && !splitsHangulBlock(value)
    && !marksIndependentVowelOddly(value)
    && !marksIndicLetterOddly(value);
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
const readsAsLatin = (letter: string) => LATIN_LETTER.test(letter) || ASCII_CONFUSABLES.has(letter);

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

// ── Indic vowels ────────────────────────────────────

// Independent vowels, dependent vowel signs and viramas (Indic_Syllabic_Category Vowel_Independent, Vowel_Dependent,
// Virama and Pure_Killer, Unicode 18) of the Indic scripts and Sinhala. The ranges also span code points unassigned
// there, which UNASSIGNED_IN_TABLES refuses. Gurmukhi iri and ura (U+0A72, U+0A73, Consonant_Placeholder)
// count as vowels: they only bear vowel signs, and iri + sign i spells the vowel letter i that Unicode encodes on its
// own
const INDEPENDENT_VOWEL = `[${[
  "\\u0904-\\u0914\\u0960\\u0961\\u0972-\\u0977", // Devanagari
  "\\u0985-\\u0994\\u09E0\\u09E1", // Bengali
  "\\u0A05-\\u0A14\\u0A72\\u0A73", // Gurmukhi
  "\\u0A85-\\u0A94\\u0AE0\\u0AE1", // Gujarati
  "\\u0B05-\\u0B14\\u0B60\\u0B61", // Oriya
  "\\u0B85-\\u0B94", // Tamil
  "\\u0C05-\\u0C14\\u0C60\\u0C61", // Telugu
  "\\u0C85-\\u0C94\\u0CE0\\u0CE1", // Kannada
  "\\u0D05-\\u0D14\\u0D5F-\\u0D61", // Malayalam
  "\\u0D85-\\u0D96", // Sinhala
].join("")}]`;
const DEPENDENT_VOWEL_SIGN = `[${[
  "\\u093A\\u093B\\u093E-\\u094C\\u094E\\u094F\\u0955-\\u0957\\u0962\\u0963", // Devanagari
  "\\u09BE-\\u09CC\\u09D7\\u09E2\\u09E3", // Bengali
  "\\u0A3E-\\u0A4C", // Gurmukhi
  "\\u0ABE-\\u0ACC\\u0AE2\\u0AE3", // Gujarati
  "\\u0B3E-\\u0B4C\\u0B53-\\u0B57\\u0B62\\u0B63", // Oriya
  "\\u0BBE-\\u0BCC\\u0BD7", // Tamil
  "\\u0C3E-\\u0C4C\\u0C55\\u0C56\\u0C62\\u0C63", // Telugu
  "\\u0CBE-\\u0CCC\\u0CD5\\u0CD6\\u0CE2\\u0CE3", // Kannada
  "\\u0D3E-\\u0D4C\\u0D57\\u0D62\\u0D63", // Malayalam
  "\\u0DCF-\\u0DDF\\u0DF2\\u0DF3", // Sinhala
].join("")}]`;
const VIRAMA = "[\\u094D\\u09CD\\u0A4D\\u0ACD\\u0B4D\\u0BCD\\u0C4D\\u0CCD\\u0D3B\\u0D3C\\u0D4D\\u0DCA]";
// The one virama an independent vowel takes: the Bengali ya-phala on A or E (maybe through a joiner), which spells
// the vowel of "Alex" and "Andrew" (অ্যা, এ্যা)
const BENGALI_YA_PHALA_ON_VOWEL = "[\\u0985\\u098F]\\u09CD\\u200D?\\u09AF";
// Marks that turn an independent vowel into the look of another vowel letter, maybe after other marks on it: a vowel
// sign (EXP-295: Devanagari E + vowel sign E draws like the letter AI, Bengali A + vowel sign AA like AA) or a virama
// (Sinhala E + al-lakuna draws like EE, also before a consonant, where some renderers show no dotted circle). The keys
// can't tell them from that letter (they drop the mark, or keep it next to the wrong letter). Unicode's "do not use"
// tables for these scripts ban such spellings; keyboards type the vowel letter itself. Latin-style diacritics (EXP-344:
// Devanagari E + combining breve like candra E) are refused on every Indic letter (marksIndicLetterOddly)
const ODDLY_MARKED_INDEPENDENT_VOWEL = new RegExp(
  `(?!${BENGALI_YA_PHALA_ON_VOWEL})${INDEPENDENT_VOWEL}\\p{M}*(?:${DEPENDENT_VOWEL_SIGN}|${VIRAMA})`,
  "u",
);

/**
 * Whether `name` puts on an independent vowel a mark that draws it like another vowel letter
 * (ODDLY_MARKED_INDEPENDENT_VOWEL), once composed: NFC turns Tamil O + AU length mark into the letter AU, a spelling
 * of its own. Signs after a consonant ("के") and anusvara, candrabindu or tippi on a vowel ("अं") are normal spellings.
 */
const marksIndependentVowelOddly = (name: string) => ODDLY_MARKED_INDEPENDENT_VOWEL.test(name.normalize("NFC"));

// ── Indic vowel signs ───────────────────────────────

// The Indic scripts and Sinhala have a block of 128 code points each, from U+0900 (Devanagari) to U+0DFF (Sinhala)
const INDIC_BLOCK_SIZE = 0x80;
const INDIC_LETTER = /^(?=\p{L})[\u0900-\u0DFF]$/u;
const VOWEL_SIGN = new RegExp(`^${DEPENDENT_VOWEL_SIGN}$`, "u");
// Marks shared by many scripts: Latin-style diacritics, Vedic accents (the Devanagari udatta and grave accent)
const INHERITED_MARK = /^\p{Script=Inherited}$/u;
// Length marks, the second half of a two-part vowel sign: NFC joins them with the first half (Kannada E + length mark
// is EE, Telugu and Oriya E + AI length mark is AI, Bengali, Oriya and Tamil E + AU length mark is AU), so one left
// over sits alone on a letter, drawn as that vowel cut in half (Kannada "ದೕವ" almost like "ದೇವ", Tamil "கௗ" like
// "கள", UTS #39). Not the Malayalam AU length mark, which alone is the modern spelling of AU ("കൗ")
const LENGTH_MARK = /^[\u09D7\u0B56\u0B57\u0BD7\u0C55\u0C56\u0CD5\u0CD6]$/u;
// Rare marks drawn where vowel signs go (EXP-362): the Gurmukhi yakash under the letter, like the U signs, and the
// Gujarati marks for Arabic sounds (sukun, shadda, maddah, the nuktas above) over it, like the E and AI signs. Next
// to a vowel sign they hide it, and the keys keep the sign but drop the mark
const MARK_HIDING_VOWEL_SIGN = /^[\u0A75\u0AFA-\u0AFF]$/u;

const indicBlockOf = (char: string) => Math.floor(char.codePointAt(0)! / INDIC_BLOCK_SIZE);

/** Whether `mark` is a mark of the script of the Indic `letter` alone: from its block, and not shared with others. */
const isOwnMark = (letter: string, mark: string) =>
  indicBlockOf(mark) === indicBlockOf(letter) && !INHERITED_MARK.test(mark);

/**
 * Whether `name`, once composed (NFC joins the two parts of a vowel such as Bengali O), carries a dependent vowel sign
 * anywhere but alone on a letter of its script, or a mark of another script on an Indic letter (EXP-343). The keys keep
 * vowel signs, so "राज" and "राजु" are different names, but drop other marks; so two signs on a letter (क + ा + े draws
 * like को, ु + े like े + ु, Sinhala ෙ + ෙ like ෛ), a sign on another script's letter, a digit or a space, or a mark
 * drawn like a sign (क + combining breve like कॅ, क + Devanagari grave accent like के) would look like a name the keys
 * don't see; so would a length mark alone (LENGTH_MARK) or a vowel sign hidden by a rare mark (MARK_HIDING_VOWEL_SIGN).
 * Real spellings put one vowel sign on a letter, with marks of its own script (nukta, anusvara, virama).
 */
function marksIndicLetterOddly(name: string): boolean {
  return Array.from(name.normalize("NFC").matchAll(LETTER_WITH_MARKS)).some(([, base, marks]) => {
    const markList = Array.from(marks);
    const vowelSigns = markList.filter((mark) => VOWEL_SIGN.test(mark)).length;
    if (!INDIC_LETTER.test(base)) return vowelSigns > 0;
    return vowelSigns > 1
      || (vowelSigns > 0 && markList.some((mark) => MARK_HIDING_VOWEL_SIGN.test(mark)))
      || markList.some((mark) => LENGTH_MARK.test(mark))
      || !markList.every((mark) => isOwnMark(base, mark));
  });
}

// ── Lookalike keys ──────────────────────────────────

// Indic dependent vowel signs, which the keys keep (EXP-343): "राज" and "राजु", Kannada "ಕರಣ" and "ಕಿರಣ" are different
// names. But the Devanagari sign OE, which iOS draws blank
const KEPT_VOWEL_SIGN = `(?!\\u093A)${DEPENDENT_VOWEL_SIGN}`;
// The Sinhala al-lakuna that NFD splits off the long E and long O signs (EXP-357: ේ is kombuva + al-lakuna, ෝ kombuva
// + aela-pilla + al-lakuna), part of the vowel sign and kept with it: "කේ" and "කෙ" are different names
const LONG_VOWEL_AL_LAKUNA = "(?<=\\u0DD9\\u0DCF?)\\u0DCA";
// Marks on a letter or symbol, voicing marks and kept vowel signs aside (see withoutMarks). A mark on a space stays:
// NFKC turns spacing accents (the arms of "¯\_(ツ)_/¯", ´, ¨) into a space plus a mark, and that mark is all they draw
const COMBINING_MARK = new RegExp(
  `(?<!\\s)(?![\\u3099\\u309A]|${KEPT_VOWEL_SIGN}|${LONG_VOWEL_AL_LAKUNA})\\p{Mn}`,
  "gu",
);
// Joiners and subdivision tags an accepted name may still carry (variation selectors go with the marks)
const IGNORABLE_IN_KEY = /[\u200C\u200D\u{E0020}-\u{E007F}]/gu;
const WHITESPACE_RUN = /\s+/gu;
// Visual key only: letters and digits that differ in some fonts, at the small sizes the app draws names
const LOOKS_LIKE_L = /[Il|1]/g;
// Visual key only: the space before a spacing ゛ or ゜, which leaves a gap but still draws the mark next to the letter
// before it, as the other spellings of a voicing mark after a space do (EXP-320)
const SPACE_BEFORE_SPACING_VOICING_MARK = /\u0020(?=[\u309B\u309C])/gu;
const VISUAL_LOOKALIKES: ReadonlyArray<[RegExp, string]> = [[/rn/g, "m"], [/vv/g, "w"], [/cl/g, "d"], [/0/g, "o"]];

/** `text` with each character found in `table` replaced by its entry. */
const replaceChars = (text: string, table: ReadonlyMap<string, string>) =>
  Array.from(text, (char) => table.get(char) ?? char).join("");

// Visual keys only: marks drawn like a vowel sign the keys keep, read as that sign (measured in Kohinoor and the Sangam
// fonts on iOS and Noto Sans on Android, or by their shape): the Devanagari and Gujarati candrabindu like their candra
// E but for a dot, the Devanagari short E and short O like E and O, the Oriya overline like the hook of sign I over the
// letter, the Sinhala candrabindu like the al-lakuna of the long E and long O (Android: KA + kombuva + candrabindu like
// KA + long E, EXP-357), and the long vocalic signs (RR, LL), which only Sanskrit spells and fonts draw as the short
// ones with one more curl, like those
const VOWEL_SIGN_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ["\u0901", "\u0945"], ["\u0A81", "\u0AC5"], ["\u0946", "\u0947"], ["\u094A", "\u094B"], ["\u0B55", "\u0B3F"],
  ["\u0D81", "\u0DCA"],
  // Vocalic RR as vocalic R (Malayalam's as U, like its vocalic R in INDIC_CONFUSABLES)
  ["\u0944", "\u0943"], ["\u09C4", "\u09C3"], ["\u0AC4", "\u0AC3"], ["\u0B44", "\u0B43"], ["\u0D44", "\u0D41"],
  // Vocalic LL as vocalic L
  ["\u0963", "\u0962"], ["\u09E3", "\u09E2"], ["\u0AE3", "\u0AE2"], ["\u0B63", "\u0B62"], ["\u0C63", "\u0C62"],
  ["\u0CE3", "\u0CE2"], ["\u0D63", "\u0D62"],
]);
// Visual keys only: the Devanagari and Gujarati candra O (sign and letter) like AA + candra E, and the Devanagari
// candra E and candra A letters like E or A + candra E (EXP-362): a candrabindu, read as candra E, differs by a dot
// ("चाँदनी" next to "चॉदनी"). UTS #39 spells them with a Latin breve or a Nandinagari sign, which no name holds; the
// Gujarati letters are in INDIC_CONFUSABLES ("ઑ" as "અાૅ", "આ" as "અા")
const CANDRA_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ["\u0949", "\u093E\u0945"], ["\u0911", "\u0906\u0945"], ["\u090D", "\u090F\u0945"], ["\u0972", "\u0905\u0945"],
  ["\u0AC9", "\u0ABE\u0AC5"],
]);
const MEASURED_INDIC_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ...VOWEL_SIGN_LOOKALIKES, ...CANDRA_LOOKALIKES,
]);
// Visual keys only (EXP-356, EXP-364): Indic characters drawn like another spelling of their script, generated from
// UTS #39 (INDIC_CONFUSABLES: Tamil "௧" as "க" and "ௗ" as "ள", Telugu "హ" as "వా", Malayalam "൬" as "ന്ന",
// Kannada "ಅ" as Telugu "అ"), and the measured ones above. The generated spellings are read through the measured
// tables ("ऎ" as "ए" + short E sign, read as E sign), so no spelling holds a character the table reads, and no measured
// entry replaces a generated one. Exported for tests
export const INDIC_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ...Array.from(INDIC_CONFUSABLES, ([char, spelling]): [string, string] =>
    [char, replaceChars(spelling, MEASURED_INDIC_LOOKALIKES)]),
  ...MEASURED_INDIC_LOOKALIKES,
]);

// Letters, signs and digits of the Indic scripts and Sinhala, the blocks INDIC_LOOKALIKES reads
const INDIC_CHAR = /[\u0900-\u0DFF]/gu;
// The Tamil vowel sign AI after its letter, or after the KSSA ligature (KA + virama + SSA, EXP-372), and their marks:
// drawn before them, and like the letter NNNA (INDIC_CONFUSABLES), so "கை" looks like "னக" (EXP-365) and "க்ஷை" like
// "னக்ஷ"
const TAMIL_AI_AFTER_LETTER = /((?:\u0B95\u0BCD\u0BB7|\p{L})\p{M}*?)\u0BC8/gu;

/** Decomposed Indic `text` with each Tamil vowel sign AI where it is drawn, before its letter or ligature. */
const tamilAiWhereDrawn = (text: string) => text.replace(TAMIL_AI_AFTER_LETTER, "\u0BC8$1");

/**
 * Indic characters drawn like another spelling of their script replaced by it (INDIC_LOOKALIKES: candrabindu as
 * candra E, Telugu HA as VA + AA, Tamil digit one as KA), the Tamil sign AI first moved before its letter. Indic
 * characters are decomposed first (NFD), so one that holds a character the table reads (the Tamil O and AU signs, the
 * letter AU) reads like its parts, however it was typed.
 */
const readIndicLookalikes = (text: string) =>
  replaceChars(tamilAiWhereDrawn(text.replace(INDIC_CHAR, (char) => char.normalize("NFD"))), INDIC_LOOKALIKES);

// Malayalam chillus typed as before Unicode 5.1, consonant + virama + zero-width joiner, which fonts draw as the
// atomic chillu (EXP-372: "Anvar" with NA + virama + joiner like "Anvar" with chillu N), each consonant with its chillu
const LEGACY_CHILLU = /([\u0D15\u0D23\u0D28\u0D30\u0D32\u0D33])\u0D4D\u200D/gu;
const ATOMIC_CHILLU_OF: Readonly<Record<string, string>> = {
  "\u0D23": "\u0D7A", "\u0D28": "\u0D7B", "\u0D30": "\u0D7C", "\u0D32": "\u0D7D", "\u0D33": "\u0D7E", "\u0D15": "\u0D7F",
};
// The Malayalam digits nine and four, drawn exactly like chillu N and chillu RR (Noto Sans and Sangam). UTS #39 spells
// them NA and RA + virama (INDIC_CONFUSABLES), which meets the legacy chillu once the keys drop the virama and joiner
const DIGIT_DRAWN_AS_CHILLU: ReadonlyMap<string, string> = new Map([["\u0D6F", "\u0D7B"], ["\u0D6A", "\u0D7C"]]);

/**
 * Visual key only: Malayalam chillus typed with a joiner, and the digits drawn like a chillu, read as the atomic chillu
 * (EXP-372). The letter visual key keeps reading them as the bare consonant, like a virama without a joiner ("Anvar"
 * with NA + virama), so a name meets both spellings through one of its keys.
 */
const readChillusAsDrawn = (text: string) => replaceChars(
  text.replace(LEGACY_CHILLU, (_legacy, consonant: string) => ATOMIC_CHILLU_OF[consonant]),
  DIGIT_DRAWN_AS_CHILLU,
);

// Code points Unicode 15.1 reserves for emoji, which names may use (see UNASSIGNED_IN_TABLES): a phone whose fonts lack
// the emoji, or any phone for those still unassigned, draws them all as the same empty box ("Ana 🫩" like "Ana 🫆").
// A fixed list, so every Node reads the same ones alike
const UNASSIGNED_EMOJI = new RegExp(codePointClass(UNASSIGNED_EMOJI_RANGES), "gu");
// What the visual keys read them as: a private-use character, which names can't use, so it only meets another of them
const EMPTY_BOX = "\uE000";

/**
 * Visual keys only: Indic characters drawn like a vowel sign or a letter and a sign read as those, emoji newer than
 * Unicode 15.1 as one box.
 */
const readDrawnAlike = (text: string) => readIndicLookalikes(text).replace(UNASSIGNED_EMOJI, EMPTY_BOX);

// ── Japanese voicing marks ──────────────────────────

// Dakuten and handakuten (EXP-287) turn a kana that takes them into another kana: たいき and だいき, はな, ばな and ぱな
// are different names. On any other character (a Latin letter, ん, a kanji) they are dropped like any other mark, so
// they can't make a lookalike of a name read as a different one; other marks on a kana with a voiced form are refused
// (marksKanaOddly).
const VOICING_MARKS = ["\u3099", "\u309A"];
const KANA_CLASS = "[\\p{Script=Hiragana}\\p{Script=Katakana}]";
const KANA = new RegExp(KANA_CLASS, "gu");
const KANA_LETTER = new RegExp(`^${KANA_CLASS}$`, "u");
// The spacing dakuten and handakuten, with the character before them (captured), which they voice like the combining
// ones if it takes them
const SPACING_VOICING_MARK = /(?<=(.))[\u309B\u309C]/gsu;
const COMBINING_FORM_OF: Readonly<Record<string, string>> = { "\u309B": "\u3099", "\u309C": "\u309A" };
// A voicing mark after a space, with the spacing mark it is drawn like (EXP-320): a combining one sits on the space,
// where a spacing ゛ or ゜ would be (NFKC spells those exactly so), and a half-width one fills the rest of that cell.
// Other marks on the space may come before it (captured, they go after the spacing mark), so their order, which NFC
// and NFD change, doesn't matter
const VOICING_MARK_AFTER_SPACE = /\u0020((?:(?![\u3099\u309A])\p{M})*)([\u3099\u309A\uFF9E\uFF9F])/gu;
const SPACING_FORM_OF: Readonly<Record<string, string>> = {
  "\u3099": "\u309B", "\uFF9E": "\u309B", "\u309A": "\u309C", "\uFF9F": "\u309C",
};
const LETTER_WITH_MARKS = /(\P{M})(\p{M}+)/gu;
// A voicing mark that NFC left out of a kana, with the character before it (none at the start)
const LOOSE_VOICING_MARK = /(?<=(.?))[\u3099\u309A]/gsu;
const WHITESPACE = /^\s$/u;

/** Characters read like a kana with a voiced form, each with the voicing marks it takes (see voicingStandIns). */
type VoicingStandIns = ReadonlyMap<string, readonly string[]>;
const NO_STAND_INS: VoicingStandIns = new Map();

/** Whether NFC joins `mark` with `letter` into one kana (た + dakuten is だ; a, ん or 漢 + dakuten aren't). */
const joinsVoicingMark = (letter: string, mark: string) => (letter + mark).normalize("NFC").length === 1;

/** The voicing marks NFC joins with `letter`: both for は, the dakuten for た, none for あ, ん, だ or a kanji. */
const voicingMarksOf = (letter: string) => VOICING_MARKS.filter((mark) => joinsVoicingMark(letter, mark));

/**
 * The voicing marks `char` takes: a kana's own (half-width read as full-width), or else those of the kana `standIns`
 * reads it, or its NFKC form, as (the Kangxi radical "power" U+2F12 is 力, read as カ).
 */
function voicingMarksTakenBy(char: string, standIns: VoicingStandIns): readonly string[] {
  const own = KANA_LETTER.test(char) ? voicingMarksOf(char.normalize("NFKC")) : [];
  return own.length > 0 ? own : standIns.get(char) ?? standIns.get(char.normalize("NFKC")) ?? [];
}

/** Voiced kana as their kana and a combining voicing mark (ぐ as く + dakuten, ㌎ as カ + dakuten ロン). */
const splitVoicedKana = (text: string) => text.replace(KANA, (kana) => kana.normalize("NFD"));

/**
 * Voiced kana split (splitVoicedKana), so the lookalike tables see the kana, also when typed with a spacing mark after
 * a kana that takes it (は + ゛ as ば, like half-width ﾊﾞ; a voicing mark after a space counts as a spacing one) or
 * after a character `standIns` reads as one (力 + ゛ as 力 + dakuten).
 */
const separateVoicing = (text: string, standIns = NO_STAND_INS) => splitVoicedKana(text
  .replace(VOICING_MARK_AFTER_SPACE, (_marksAfterSpace, otherMarks: string, mark: string) =>
    SPACING_FORM_OF[mark] + otherMarks)
  .replace(SPACING_VOICING_MARK, (mark, before: string) => {
    const combining = COMBINING_FORM_OF[mark];
    return voicingMarksTakenBy(before, standIns).includes(combining) ? combining : mark;
  }));

/**
 * Characters that `table` reads like a kana with a voiced form, each with the voicing marks that kana takes: in the
 * visual key "〈" + dakuten reads as ぐ (both read as く there), "力" + dakuten as ガ (力 and カ) and "朩" +
 * handakuten as ポ (朩 reads as ホ). Kana drawn like the same prototype pool their marks, so none hides another's.
 * Exported for tests.
 */
export function voicingStandIns(table: ReadonlyMap<string, string>): VoicingStandIns {
  const marksByPrototype = new Map<string, Set<string>>();
  const addMarksOf = (kana: string, prototype: string) => {
    const marks = voicingMarksOf(kana.normalize("NFKC"));
    if (marks.length === 0) return;
    const pooled = marksByPrototype.get(prototype) ?? new Set<string>();
    marks.forEach((mark) => pooled.add(mark));
    marksByPrototype.set(prototype, pooled);
  };
  for (const [char, prototype] of table) {
    if (KANA_LETTER.test(char)) addMarksOf(char, prototype);
    addMarksOf(prototype, prototype);
  }
  const standIns = new Map<string, readonly string[]>();
  for (const [prototype, marks] of marksByPrototype) standIns.set(prototype, [...marks]);
  for (const [char, prototype] of table) {
    const marks = marksByPrototype.get(prototype);
    if (marks) standIns.set(char, [...marks]);
  }
  return standIns;
}

const SYMBOL_VOICING_STAND_INS = voicingStandIns(SYMBOL_CONFUSABLES);

/**
 * Whether `name` puts on a kana with a voiced form, or on a symbol or kanji drawn like one (SYMBOL_VOICING_STAND_INS:
 * 〈, 力), any mark but one voicing mark it takes: two voicing marks (ぱ + dakuten), or a mark drawn like one (は +
 * ring above looks like ぱ, た + diaeresis like だ), would read as a voiced kana the keys don't see. Japanese puts no
 * other marks on kana or kanji; on other kana (ノ in the kaomoji "(ﾉﾟ∀ﾟ)ﾉ", あ, ん) marks are dropped from the keys
 * like on any letter.
 */
function marksKanaOddly(name: string): boolean {
  const decomposed = separateVoicing(name, SYMBOL_VOICING_STAND_INS).normalize("NFKC").normalize("NFD");
  return Array.from(decomposed.matchAll(LETTER_WITH_MARKS)).some(([, letter, marks]) => {
    const marksTaken = voicingMarksTakenBy(letter, SYMBOL_VOICING_STAND_INS);
    return marksTaken.length > 0 && !marksTaken.includes(marks);
  });
}

/**
 * `decomposed` (NFD) without the combining marks on a letter or symbol, composed (NFC), keeping a voicing mark that
 * joins its kana or that the letter before it takes as a stand-in (`standIns`). The other marks go first, so one
 * between a kana and its voicing mark doesn't keep NFC from joining them.
 */
function withoutMarks(decomposed: string, standIns: VoicingStandIns): string {
  const composed = decomposed.replace(COMBINING_MARK, "").normalize("NFC");
  return composed.replace(LOOSE_VOICING_MARK, (mark, before: string) =>
    WHITESPACE.test(before) || standIns.get(before)?.includes(mark) ? mark : "");
}

// ── Hangul ──────────────────────────────────────────

// Hangul letters: syllables, conjoining jamo and their compatibility and half-width forms
const HANGUL_RUN = /\p{Script=Hangul}+/gu;

/**
 * `text` with conjoining jamo composed into the syllable they draw (EXP-294): ᄋ + ᅵ is 이, 이 + ᆼ is 잉. The lookalike
 * tables read some jamo on their own (ᄋ as "o", ᅳ as "ー"), so they must not see the pieces of a syllable. Only
 * Hangul is composed: other scripts keep the marks the tables run before.
 */
const composeHangul = (text: string) => text.replace(HANGUL_RUN, (run) => run.normalize("NFC"));

// Conjoining jamo: leading consonants, vowels and trailing consonants, with their extended blocks
const CONJOINING_JAMO = /[\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]/u;

// Compatibility jamo (ㄱ, ㅏ) and their half-width forms (ﾡ, ￂ) are letters drawn on their own, one per cell, never
// joined into a syllable block: "ㄱㅏ" shows two letters, "가" one (EXP-324). NFKC turns them into conjoining jamo and
// composes those into syllables, so the keys keep them out of NFKC (keepingCompatibilityJamo) and read the conjoining
// jamo still on their own after composing as compatibility letters (compatibilityLetters). So "ㄱㅏ" stays apart from
// "가", as "ㅇㅣ" from "이", while half-width "ﾡￂ", lone conjoining "ᄀ ᅡ" (drawn as separate letters too) and "ㄱㅏ"
// share their keys like before. NFKC sends each compatibility jamo to a different leading consonant, vowel or (when it
// has no leading form, as ㄳ) trailing consonant, which gives the map back.
const FIRST_COMPATIBILITY_JAMO = 0x3131;
const LAST_COMPATIBILITY_JAMO = 0x318e;
const COMPATIBILITY_JAMO = Array.from(
  { length: LAST_COMPATIBILITY_JAMO - FIRST_COMPATIBILITY_JAMO + 1 },
  (_, i) => String.fromCodePoint(FIRST_COMPATIBILITY_JAMO + i),
);
// Consonants have a leading and a trailing conjoining jamo, but NFKC sends each compatibility letter to only one of
// them (ㄱ to the leading ᄀ, ㄳ to the trailing ᆪ). Alone, the other form is drawn like the letter in many fonts too,
// so it reads as that letter as well (EXP-333): the trailing ᆨ as ㄱ. Pairs of [conjoining jamo, compatibility letter]
// code points with the same Unicode name (HANGUL JONGSEONG KIYEOK and HANGUL LETTER KIYEOK).
const OTHER_FORM_CONSONANT_LETTERS: ReadonlyArray<readonly [number, number]> = [
  // Modern trailing consonants
  [0x11a8, 0x3131], [0x11a9, 0x3132], [0x11ab, 0x3134], [0x11ae, 0x3137], [0x11af, 0x3139], [0x11b6, 0x3140],
  [0x11b7, 0x3141], [0x11b8, 0x3142], [0x11b9, 0x3144], [0x11ba, 0x3145], [0x11bb, 0x3146], [0x11bc, 0x3147],
  [0x11bd, 0x3148], [0x11be, 0x314a], [0x11bf, 0x314b], [0x11c0, 0x314c], [0x11c1, 0x314d], [0x11c2, 0x314e],
  // Archaic trailing consonants
  [0x11c6, 0x3166], [0x11dc, 0x316e], [0x11e2, 0x3171], [0x11e6, 0x3178], [0x11e7, 0x317a], [0x11e8, 0x317c],
  [0x11ea, 0x317d], [0x11eb, 0x317f], [0x11ee, 0x3180], [0x11f0, 0x3181], [0x11f4, 0x3184], [0x11f9, 0x3186],
  [0x11ff, 0x3165], [0xd7cd, 0x3138], [0xd7e3, 0x3173], [0xd7e6, 0x3143], [0xd7e7, 0x3175], [0xd7e8, 0x3176],
  [0xd7ef, 0x317e], [0xd7f9, 0x3149],
  // Archaic leading consonant clusters
  [0x115b, 0x3167], [0x115c, 0x3135], [0x115d, 0x3136], [0xa964, 0x313a], [0xa966, 0x316a], [0xa968, 0x313b],
  [0xa969, 0x313c], [0xa96c, 0x313d], [0xa971, 0x316f],
];
/**
 * Each conjoining jamo with the compatibility letter it is drawn like on its own: the one NFKC makes of that letter
 * (ᄀ: ㄱ, ᅡ: ㅏ, ᆪ: ㄳ) or the other form of the same consonant (ᆨ: ㄱ).
 */
const COMPATIBILITY_LETTER_OF: ReadonlyMap<string, string> = new Map([
  ...COMPATIBILITY_JAMO.map((letter): [string, string] => [letter.normalize("NFKC"), letter]),
  ...OTHER_FORM_CONSONANT_LETTERS.map(([jamo, letter]): [string, string] =>
    [String.fromCodePoint(jamo), String.fromCodePoint(letter)]),
]);
// A compatibility or half-width jamo, captured so that splitting a text on it keeps it
const LETTER_JAMO = /([\u3131-\u318E\uFFA0-\uFFDC])/u;
const CONJOINING_JAMO_ALL = new RegExp(CONJOINING_JAMO.source, "gu");

/** `jamo` as its compatibility letter (half-width ﾡ and conjoining ᄀ as ㄱ), if it has one; else as itself. */
const compatibilityLetter = (jamo: string) => COMPATIBILITY_LETTER_OF.get(jamo.normalize("NFKC")) ?? jamo;

/** NFKC of `text`, but with its compatibility and half-width jamo as compatibility letters, never composed. */
const keepingCompatibilityJamo = (text: string) => text
  .split(LETTER_JAMO)
  .map((part, i) => (i % 2 === 1 ? compatibilityLetter(part) : part.normalize("NFKC")))
  .join("");

/** `text` with each conjoining jamo (that NFC left on its own) as its compatibility letter, if it has one. */
const compatibilityLetters = (text: string) => text.replace(CONJOINING_JAMO_ALL, compatibilityLetter);

const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Whether a grapheme cluster of `text` holds conjoining jamo that NFC doesn't turn into a single character. */
const hasUnjoinedJamoCluster = (text: string) =>
  Array.from(GRAPHEMES.segment(text), ({ segment }) => segment).some((cluster) =>
    CONJOINING_JAMO.test(cluster) && Array.from(cluster.normalize("NFC")).length > 1);

/**
 * Whether `name` holds conjoining jamo drawn in one block with letters NFC doesn't join them with (EXP-294): a double
 * consonant or compound vowel typed as two simple jamo (ᄀ + 가, 가 + ᅵ) looks like the syllable that has it (까, 개)
 * but would get another key. Checked also without the combining marks, which the keys drop and which would otherwise
 * split the cluster (가 + acute + ᅵ). Lone jamo ("ᄋ", "(ᅳ_ᅳ)") and every jamo spelling of a syllable (ᄋ + ᅵ, 이 + ᆼ)
 * are fine; a jamo carrying a mark and archaic jamo clusters are refused.
 */
function splitsHangulBlock(name: string): boolean {
  const withoutAnyMark = name.normalize("NFD").replace(ANY_MARK, "").normalize("NFC");
  return hasUnjoinedJamoCluster(name) || hasUnjoinedJamoCluster(withoutAnyMark);
}

// ── Key steps ───────────────────────────────────────

/** Each character drawn like ASCII letters or digits replaced by them (UTS #39 table, see asciiConfusables.ts). */
const toAscii = (text: string) => replaceChars(text, ASCII_CONFUSABLES);

/** Characters drawn like other symbols replaced by them ("∙" as "•", "ǃ" as "!", "一" as "ー"; asciiConfusables.ts). */
const foldSymbols = (text: string) => replaceChars(text, SYMBOL_CONFUSABLES);

/** Upper then lower approximates Unicode case folding (sharp s to "ss", final sigma to sigma), unlike toLowerCase. */
const foldCase = (text: string) => text.toUpperCase().toLowerCase();

/**
 * Hangul conjoining jamo composed into syllables, lookalikes read as ASCII (case kept: Greek small nu reads as "v" but
 * capital nu as "N"), then NFKC (full-width, styled letters) but for compatibility jamo, accents and other combining
 * marks on a letter or symbol dropped (but an Indic vowel sign, with the al-lakuna of a Sinhala long vowel, and a
 * voicing mark on a kana that takes it, or on a letter that `standIns` reads as one), conjoining jamo still on their
 * own read as compatibility letters, the table again for what NFKC and the marks uncovered, joiners dropped, whitespace
 * trimmed and collapsed. The table runs before NFKC too because NFKC can lose the look: long s reads as "f" but NFKC
 * turns it into "s".
 */
function skeleton(name: string, standIns = NO_STAND_INS): string {
  const lookalikesRead = toAscii(separateVoicing(composeHangul(name), standIns));
  const decomposed = keepingCompatibilityJamo(lookalikesRead).normalize("NFD");
  const bare = compatibilityLetters(withoutMarks(decomposed, standIns).normalize("NFC"));
  return toAscii(bare).replace(IGNORABLE_IN_KEY, "").replace(WHITESPACE_RUN, " ").trim();
}

/**
 * Comparison key of a name: its case-folded skeleton. "bob", "BOB", full-width "bob", "bob" with a dot below, "dave"
 * in Latin small capitals, Cherokee letters drawn like "DAVE", "Pa∪l" (union sign) or "A│ice" (box drawing) share a
 * key with their plain spelling. The table runs again after folding for the lowercase forms of letters only listed in
 * uppercase.
 */
export function nameKey(name: string): string {
  return toAscii(foldCase(skeleton(name)));
}

/**
 * Looser key for symbols drawn like other symbols and letter groups that only differ in some fonts: symbols read as
 * their UTS #39 prototype of the same size ("(∙_∙)" as "(•_•)", "ǃǃ" as "!!", "¯" as "ˉ", curly quotes as straight
 * ones), I / l / | / 1 as "l", then "rn" as "m", "vv" as "w", "cl" as "d" and 0 as "o" ("AIice" reads as "Alice",
 * "rnike" as "mike"). The symbol table runs before the skeleton too because NFKC can lose the look: the macron "¯"
 * becomes a space and a combining macron; Hangul jamo are composed before it, as in the skeleton. Kana read as the
 * kanji or kana drawn like them ("カ" as "力", "ヘ" as "へ"), and a voicing mark on a symbol or kanji read as a kana
 * counts as on that kana: "〈" + dakuten reads as ぐ, "力" + dakuten as ガ; so does a spacing ゛ or ゜ after a space
 * ("た ゛" looks like だ). Voiced kana that NFKC made (squared "㌎" is ガロン) are split again so the second pass sees
 * the kana. Marks drawn like an Indic vowel sign read as that sign (EXP-343: "सँम" like "सॅम"), Indic characters
 * drawn like a letter and a vowel sign as those (EXP-356: "హరి" like "వారి", "चॉदनी" like "चाँदनी"), and every emoji
 * newer than Unicode 15.1 as the same empty box, as phones without it draw it ("Ana 🫩" like "Ana 🫆").
 * Malayalam chillus typed with a joiner, and the digits drawn like a chillu, read as the atomic chillu first (EXP-372,
 * readChillusAsDrawn).
 */
export function visualKey(name: string): string {
  const voicingMarksClosed = composeHangul(readDrawnAlike(readChillusAsDrawn(name)))
    .replace(SPACE_BEFORE_SPACING_VOICING_MARK, "");
  const symbols = foldSymbols(separateVoicing(voicingMarksClosed, SYMBOL_VOICING_STAND_INS));
  const skeletal = foldSymbols(splitVoicedKana(skeleton(symbols, SYMBOL_VOICING_STAND_INS)));
  return readLetterLookalikes(skeletal);
}

/**
 * The visual key without the symbol table (EXP-285): the skeleton with only the letter groups that differ in some
 * fonts, the marks drawn like an Indic vowel sign, the Indic characters drawn like a letter and a vowel sign (EXP-356)
 * and the emoji newer than Unicode 15.1 read alike. The symbol table reads small or circled o and zero as other symbols ("º", "ᵒ" and "⁰" as the degree sign, which keeps "(º_º)" next to "(°_°)"); here NFKC reads them as
 * the letter or digit they also look like, so "b⁰b" and "b⓪b" still meet "bob", and "bºb" meets "b0b".
 */
export function letterVisualKey(name: string): string {
  return readLetterLookalikes(skeleton(readDrawnAlike(name)));
}

/** A skeleton with I / l / | / 1 as "l", case folded, then "rn" as "m", "vv" as "w", "cl" as "d" and 0 as "o". */
function readLetterLookalikes(skeletal: string): string {
  const folded = toAscii(foldCase(skeletal.replace(LOOKS_LIKE_L, "l")));
  return VISUAL_LOOKALIKES.reduce((key, [pattern, replacement]) => key.replace(pattern, replacement), folded);
}

// ── Comparing names ─────────────────────────────────

/** The keys of a name read in one order. */
interface OrderKeys {
  readonly same: string;
  readonly visual: string;
  readonly letterVisual: string;
}

/** The keys of a name as stored and as drawn on screen (right-to-left letters reversed, see displayOrder). */
export interface NameKeys {
  readonly stored: OrderKeys;
  readonly drawn: OrderKeys;
}

/** How a name compares with another: the same name, a different one that looks too alike, or distinct. */
export type NameClash = "same" | "similar" | null;

const orderKeys = (text: string): OrderKeys => ({
  same: nameKey(text),
  visual: visualKey(text),
  letterVisual: letterVisualKey(text),
});

/** Keys of `name` (compute once per player: see RoomManager). */
export function nameKeys(name: string): NameKeys {
  return { stored: orderKeys(name), drawn: orderKeys(displayOrder(name)) };
}

/**
 * "same" when the names share a nameKey ("bob" and "BOB", "bob" with a Cyrillic o, "Milo" and "Mi" + Hebrew samekh
 * and vav, which draw as "lo"); "similar" when they only share a visualKey or a letterVisualKey ("Alice" and "AIice",
 * "Clara" and "Dara", "bob" and "b⁰b").
 * Stored order is compared with stored order and drawn with drawn, so a right-to-left name never meets its reversal.
 */
export function nameClash(a: NameKeys, b: NameKeys): NameClash {
  const matches = (key: keyof OrderKeys) => a.stored[key] === b.stored[key] || a.drawn[key] === b.drawn[key];
  if (matches("same")) return "same";
  return matches("visual") || matches("letterVisual") ? "similar" : null;
}

/** Whether two names are the same name (nameClash "same"). */
export function sameName(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) === "same";
}

/** Whether two names would read alike on screen (the same name or too similar). */
export function looksLike(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) !== null;
}
