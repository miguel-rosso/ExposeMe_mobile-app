import {
  ASCII_CONFUSABLES, EXTENDED_PICTOGRAPHIC_RANGES, INDIC_CONFUSABLES, SYMBOL_CONFUSABLES, UNASSIGNED_EMOJI_RANGES,
  UNASSIGNED_NON_EMOJI_RANGES,
} from "./asciiConfusables";
import { displayOrder } from "./displayOrder";
import { BLANK_GLYPHS, codePointClass, MARK_PILE_SOURCE } from "./textGlyphs";

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
// Client/src/utils/protocolLimits.ts; qa/lab/tests/protocol-constants.test.sh checks they are equal)
export const MAX_USERNAME_LENGTH = 15;
// NFKC can expand one character a lot (the Arabic ligature U+FDFA is 18 letters): bounds the work of the name keys
const MAX_NORMALIZED_LENGTH = 60;

// ── Validation ──────────────────────────────────────

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
// The Malayalam consonants with a chillu, each with its atomic chillu. Typed as before Unicode 5.1, a chillu is the
// consonant + virama + zero-width joiner (EXP-372), which old keyboards still send, also at the end of a word ("Kamal"
// with LA + virama + joiner): there the joiner is allowed with nothing after it, as the chillu it draws is visible
// whatever follows. Not before a mark, which would draw on the chillu, nor before a letter: there only SCRIPT_JOINER
// allows it, as in a cursive script outside JOINER_SCRIPTS (Adlam, N'Ko, Mongolian) the joiner would shape the letter.
const ATOMIC_CHILLU_OF: Readonly<Record<string, string>> = {
  "\u0D23": "\u0D7A", "\u0D28": "\u0D7B", "\u0D30": "\u0D7C", "\u0D32": "\u0D7D", "\u0D33": "\u0D7E", "\u0D15": "\u0D7F",
};
const CHILLU_CONSONANT = `[${Object.keys(ATOMIC_CHILLU_OF).join("")}]`;
const LEGACY_CHILLU_JOINER = new RegExp(`(?<=${CHILLU_CONSONANT}\\u0D4D)\\u200D(?![\\p{M}\\p{L}])`, "gu");

// Controls, format characters (zero-width, bidi overrides, BOM, tags), private-use/surrogate code points,
// line/paragraph separators, default-ignorable characters (fillers, variation selectors, combining grapheme joiner),
// characters drawn blank (braille blank, Khitan filler, musical null notehead, object replacement) and every space
// other than the plain one (no-break, ideographic, en/em spaces...). Unassigned code points: UNASSIGNED_IN_TABLES.
const INVISIBLE = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}${BLANK_GLYPHS}]|(?!\\u0020)\\p{Zs}`,
  "u",
);
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
// Spacing marks (Mc) take room beside a letter like one: no script repeats one right after itself, and none puts more
// than MAX_MARKS_ON_A_LETTER marks of any kind on a letter (a Burmese syllable carries up to five, EXP-454)
const MAX_MARKS_ON_A_LETTER = 8;
// More stacking marks on a letter than real spellings use ("Zalgo" text), more marks than any spelling, or a doubled
// spacing mark
const MARK_PILE = new RegExp(
  `${MARK_PILE_SOURCE}|\\p{M}{${MAX_MARKS_ON_A_LETTER + 1}}|(\\p{Mc})\\1`,
  "u",
);

/**
 * `text` without the format characters allowed where they belong: inside an emoji, between two joining letters, and the
 * joiner of a Malayalam chillu typed as consonant + virama + joiner when no mark or letter follows it, e.g. at the end
 * of a word (LEGACY_CHILLU_JOINER, whose consonants come from ATOMIC_CHILLU_OF: a chillu added there is allowed here).
 */
const withoutAllowedFormatChars = (text: string) => text
  .replace(EMOJI_JOINER, "")
  .replace(EMOJI_PRESENTATION, "")
  .replace(EMOJI_TAG_SEQUENCE, "")
  .replace(SCRIPT_JOINER, "")
  .replace(LEGACY_CHILLU_JOINER, "");

/**
 * A name the server accepts: a string of 1–15 UTF-16 units (at most 60 after NFKC), not blank, with no invisible
 * characters, characters the lookalike tables don't know (unassigned in their Unicode 15.1; newer emoji are fine, and
 * read alike by visualKey) or spaces other than U+0020, no space at either end or two in a row, no combining mark at
 * the start or on a trailing space, at most four stacking marks on a letter (MARK_PILE_SOURCE: spacing marks don't
 * count), no mark on a kana with a voiced form but the voicing mark it takes (marksKanaOddly), no mix of
 * Latin-lookalike scripts (see mixesLookalikeScripts), no Hangul block of jamo that don't make one syllable
 * (splitsHangulBlock), no vowel sign or virama on an Indic independent vowel
 * (marksIndependentVowelOddly) and no Indic vowel sign but one on a letter of its script, which carries only marks of
 * that script, no length mark left alone, no rare mark hiding a vowel sign and no virama but one ending the marks of a
 * letter, after nothing but a nukta, nor an archaic Malayalam one (marksIndicLetterOddly). Emoji, symbols, punctuation
 * and digits are free: a name may be made only of them.
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
export const VIRAMA = "[\\u094D\\u09CD\\u0A4D\\u0ACD\\u0B4D\\u0BCD\\u0C4D\\u0CCD\\u0D3B\\u0D3C\\u0D4D\\u0DCA]";
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

const VIRAMA_MARK = new RegExp(`^${VIRAMA}$`, "u");
// The nuktas, which come before the virama on a letter (canonical order): "फ़्रेड" (Fred)
const NUKTA = /^[\u093C\u09BC\u0A3C\u0ABC\u0B3C\u0C3C\u0CBC]$/u;
// Indic letters with no vowel for a virama to kill: avagrahas, om signs, the Bengali anji, the Tamil visarga, the
// Kannada spacing candrabindu, jihvamuliya and upadhmaniya, the Vedic anusvaras, the Devanagari high spacing dot, and
// the dead consonants (Bengali khanda ta, Telugu and Kannada nakaara pollu, Malayalam dot reph and chillus)
const TAKES_NO_VIRAMA = new RegExp(`^[${[
  "\\u093D\\u0950\\u0971", // Devanagari
  "\\u0980\\u09BD\\u09CE\\u09FC", // Bengali
  "\\u0A74", // Gurmukhi
  "\\u0ABD\\u0AD0", // Gujarati
  "\\u0B3D", // Oriya
  "\\u0B83\\u0BD0", // Tamil
  "\\u0C3D\\u0C5D", // Telugu
  "\\u0C80\\u0CBD\\u0CDD\\u0CF1\\u0CF2", // Kannada
  "\\u0D04\\u0D3D\\u0D4E\\u0D54-\\u0D56\\u0D7A-\\u0D7F", // Malayalam
].join("")}]$`, "u");

// The archaic Malayalam viramas, vertical bar and circle, which no keyboard types: a tick or ring where the
// chandrakkala draws its stroke, so a font draws them like it or like a dot
const ARCHAIC_MALAYALAM_VIRAMA = /^[\u0D3B\u0D3C]$/u;
// Marks the keys drop that are drawn like the virama of their script with a dot, or as a ring where it goes (Noto
// Sans and the Sangam fonts; EXP-374: "കമലഁ" like "കമല്", "කමලඁ" like "කමල්"): the Malayalam candrabindu and
// combining anusvara above, which no modern name uses, and the Sinhala candrabindu but over a kombuva, where it is
// drawn like the al-lakuna of the long E and long O and the visual keys read it so (SINHALA_CANDRABINDU_ON_KOMBUVA)
const MARK_DRAWN_AS_VIRAMA = /[\u0D00\u0D01]|(?<![\u0DD9\u0DDC])\u0D81/u;

/**
 * Whether `marks` put a virama on `base` other than one closing the marks of a consonant or vowel letter, after
 * nothing but a nukta (EXP-374), or an archaic Malayalam virama. The keys keep viramas, but only on a letter of their
 * script, so one on a digit, an avagraha or punctuation, before or after a vowel sign or anusvara, or a second one
 * would draw like a name the keys don't see ("ઽ્ष" next to "ऽ्ष", Telugu "వ్ారి" next to "హ్రి").
 */
function placesViramaOddly(base: string, marks: readonly string[]): boolean {
  const virama = marks.findIndex((mark) => VIRAMA_MARK.test(mark));
  if (virama < 0) return false;
  return !INDIC_LETTER.test(base) || TAKES_NO_VIRAMA.test(base) || virama !== marks.length - 1
    || !marks.slice(0, virama).every((mark) => NUKTA.test(mark))
    || ARCHAIC_MALAYALAM_VIRAMA.test(marks[virama]);
}

/**
 * Whether `name`, once composed (NFC joins the two parts of a vowel such as Bengali O), carries a dependent vowel sign
 * anywhere but alone on a letter of its script, or a mark of another script on an Indic letter (EXP-343). The keys keep
 * vowel signs, so "राज" and "राजु" are different names, but drop other marks; so two signs on a letter (क + ा + े draws
 * like को, ु + े like े + ु, Sinhala ෙ + ෙ like ෛ), a sign on another script's letter, a digit or a space, or a mark
 * drawn like a sign (क + combining breve like कॅ, क + Devanagari grave accent like के) would look like a name the keys
 * don't see; so would a length mark alone (LENGTH_MARK), a vowel sign hidden by a rare mark (MARK_HIDING_VOWEL_SIGN)
 * a virama anywhere but last on a letter (placesViramaOddly) or a mark drawn like a virama that the keys drop
 * (MARK_DRAWN_AS_VIRAMA). Real spellings put one vowel sign on a letter, with marks of its own script (nukta,
 * anusvara), or a virama after maybe a nukta.
 */
function marksIndicLetterOddly(name: string): boolean {
  return Array.from(name.normalize("NFC").matchAll(LETTER_WITH_MARKS)).some(([, base, marks]) => {
    const markList = Array.from(marks);
    const vowelSigns = markList.filter((mark) => VOWEL_SIGN.test(mark)).length;
    if (placesViramaOddly(base, markList) || MARK_DRAWN_AS_VIRAMA.test(marks)) return true;
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
// The viramas the keys keep (EXP-374), drawn as a stroke or hook on the letter: a dead consonant, a conjunct or a
// Malayalam legacy chillu is another name than the bare letters ("കമല്" Kamal and "കമല" Kamala, "क्ष" and "कष"); so
// is a Sinhala al-lakuna, like the one NFD splits off the long E and O signs (EXP-357: "කේ" and "කෙ"). Not the Tamil
// pulli, a dot dropped like a Latin dot above ("கமல்" stays the name "கமல"), nor the nuktas, dots under the
// letter ("ज़ैनब" and "जैनब" are one name); names can't hold the archaic Malayalam viramas (placesViramaOddly).
const KEPT_VIRAMAS = ["\u094D", "\u09CD", "\u0A4D", "\u0ACD", "\u0B4D", "\u0C4D", "\u0CCD", "\u0D4D", "\u0DCA"];
// Sister scripts the visual keys read as one: Gurmukhi letters drawn like Devanagari ones and Kannada letters like
// Telugu ones (INDIC_CONFUSABLES), with their viramas (CROSS_SCRIPT_SIGN_LOOKALIKES)
const SISTER_BLOCKS: ReadonlyArray<readonly number[]> = [[0x0900, 0x0a00], [0x0c00, 0x0c80]];

/** A regex class of the code points of an Indic `mark`'s script: its block, with its sister block (SISTER_BLOCKS). */
function scriptClassOf(mark: string): string {
  const block = indicBlockOf(mark) * INDIC_BLOCK_SIZE;
  const blocks = SISTER_BLOCKS.find((sisters) => sisters.includes(block)) ?? [block];
  return codePointClass(blocks.map((start) => [start, start + INDIC_BLOCK_SIZE - 1] as const));
}

// A kept virama on a character of its script (or a sister script) that is no mark, maybe after other marks. Names put
// it on no other letter (marksIndicLetterOddly), but the visual keys read some letters as another script's: there the
// virama is dropped, as the Tamil pulli is ("ഥ്" reads like "ம்" and "ம"); Gurmukhi and Kannada viramas are
// read as the Devanagari and Telugu ones first (CROSS_SCRIPT_SIGN_LOOKALIKES), so "ਟ੍" still reads like "ट्" and
// "ਪ੍ਰੇਮ" keeps its virama
const KEPT_VIRAMA = KEPT_VIRAMAS
  .map((virama) => `(?<=(?=\\P{M})${scriptClassOf(virama)}\\p{M}*)${virama}`)
  .join("|");
// The Sinhala al-lakuna that NFD splits off the long E and long O signs (EXP-357), part of the vowel sign: kept
// whatever the kombuva follows, also a mark the ASCII table read first (the anusvara as "o" in "කංේ")
const LONG_VOWEL_AL_LAKUNA = "(?<=\\u0DD9\\u0DCF?)\\u0DCA";
// Marks on a letter or symbol, voicing marks, kept vowel signs and viramas aside (see withoutMarks). A mark on a space
// stays: NFKC turns spacing accents (the arms of "¯\_(ツ)_/¯", ´, ¨) into a space plus a mark, and that mark is all
// they draw
const COMBINING_MARK = new RegExp(
  `(?<!\\s)(?![\\u3099\\u309A]|${KEPT_VOWEL_SIGN}|${LONG_VOWEL_AL_LAKUNA}|${KEPT_VIRAMA})\\p{Mn}`,
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
// letter, and the long vocalic signs (RR, LL), which only Sanskrit spells and fonts draw as the short ones with one
// more curl, like those
const VOWEL_SIGN_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ["\u0901", "\u0945"], ["\u0A81", "\u0AC5"], ["\u0946", "\u0947"], ["\u094A", "\u094B"], ["\u0B55", "\u0B3F"],
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
// Visual keys only (EXP-375, EXP-386): Gurmukhi vowel signs drawn like the Devanagari ones (Gurmukhi MN and Kohinoor
// on iOS, Noto Sans on Android), so a Gurmukhi letter drawn like a Devanagari one (INDIC_CONFUSABLES: "ਟ" as "ट")
// copies its syllable too: II like II and EE like E ("ਟੀ" like "टी", "ਟੇ" like "टे"). Left out, drawn apart: AA (the
// kanna stops at mid height), U, UU and AU (other hooks, no AU bar), OO (see INDIC_CONFUSABLES); and the Malayalam
// AA, II, U and UU signs next to the Tamil ones, on the Malayalam letters drawn like Tamil ones ("ഖ" as "வ")
// The viramas the keys keep (EXP-374) likewise: the Gurmukhi one like the Devanagari stroke ("ਟ੍" like "ट्",
// Gurmukhi MN; UTS #39), and the Kannada one, a curl at the top right, as the Telugu hook there, so a Kannada letter
// read as its Telugu twin ("ಜ" as "జ") still meets it with a virama, as when the keys dropped both
const CROSS_SCRIPT_SIGN_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ["\u0A40", "\u0940"], ["\u0A47", "\u0947"], ["\u0A4D", "\u094D"], ["\u0CCD", "\u0C4D"],
]);
const MEASURED_INDIC_LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ...VOWEL_SIGN_LOOKALIKES, ...CANDRA_LOOKALIKES, ...CROSS_SCRIPT_SIGN_LOOKALIKES,
]);
// Visual keys only (EXP-356, EXP-364): Indic characters drawn like another spelling of their script, generated from
// UTS #39 (INDIC_CONFUSABLES: Tamil "௧" as "க" and "ௗ" as "ள", Telugu "హ" as "వా", Malayalam "൬" as "ന്ന",
// Kannada "ಅ" as Telugu "అ"; EXP-375, reviewed across sister scripts: Gurmukhi "ਟ" as Devanagari "ट", Malayalam "ഖ"
// as Tamil "வ"), and the measured ones above. The generated spellings are read through the measured
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

// The Sinhala candrabindu over a kombuva (and aela-pilla), drawn where the al-lakuna of the long E and long O goes
// (Android: KA + kombuva + candrabindu like KA + long E, EXP-357). Names can't hold it on a bare letter, where it is
// drawn like the al-lakuna with a dot (MARK_DRAWN_AS_VIRAMA)
const SINHALA_CANDRABINDU_ON_KOMBUVA = /(?<=\u0DD9\u0DCF?)\u0D81/gu;
const SINHALA_AL_LAKUNA = "\u0DCA";

/**
 * Indic characters drawn like another spelling of their script replaced by it (INDIC_LOOKALIKES: candrabindu as
 * candra E, Telugu HA as VA + AA, Tamil digit one as KA), the Tamil sign AI first moved before its letter, and the
 * Sinhala candrabindu over a kombuva read as the al-lakuna there. Indic characters are decomposed first (NFD), so one
 * that holds a character the table reads (the Tamil O and AU signs, the letter AU) reads like its parts, however it was
 * typed.
 */
const readIndicLookalikes = (text: string) => replaceChars(
  tamilAiWhereDrawn(text.replace(INDIC_CHAR, (char) => char.normalize("NFD"))),
  INDIC_LOOKALIKES,
).replace(SINHALA_CANDRABINDU_ON_KOMBUVA, SINHALA_AL_LAKUNA);

// Dead consonants typed as before they had a letter of their own, consonant + virama + zero-width joiner, which fonts
// draw as that letter: the Malayalam chillus before Unicode 5.1 (EXP-372: "Anvar" with NA + virama + joiner like
// "Anvar" with chillu N), in a word or ending it, and the Bengali khanda ta before Unicode 4.1 (EXP-402: "Utsab" with
// TA + hasanta + joiner like "উৎসব" in Noto Sans, Kohinoor, Bangla MN and Sangam MN), which names only hold before a
// letter (SCRIPT_JOINER). Each is a reading the visual keys take besides the name as typed (similarKeys), where they
// read as the consonant + virama, like a virama without a joiner ("Anvar" with NA + virama), so a name meets both
// spellings; not the bare consonant, another name (EXP-374: "Kamal" and "Kamala")
const LEGACY_CHILLU = new RegExp(`(${CHILLU_CONSONANT})\\u0D4D\\u200D`, "gu");
const LEGACY_KHANDA_TA = /\u09A4\u09CD\u200D/gu;
const KHANDA_TA = "\u09CE";
// The Malayalam digits nine and four, drawn exactly like chillu N and chillu RR (Noto Sans and Sangam). UTS #39 spells
// them NA and RA + virama (INDIC_CONFUSABLES), which meets the legacy chillu once the keys drop the joiner
const DIGIT_DRAWN_AS_CHILLU: ReadonlyMap<string, string> = new Map([["\u0D6F", "\u0D7B"], ["\u0D6A", "\u0D7C"]]);

/** Malayalam chillus typed with a joiner, and the digits drawn like a chillu, read as the atomic chillu (EXP-372). */
const readChillusAsDrawn = (text: string) => replaceChars(
  text.replace(LEGACY_CHILLU, (_legacy, consonant: string) => ATOMIC_CHILLU_OF[consonant]),
  DIGIT_DRAWN_AS_CHILLU,
);

/** The Bengali khanda ta typed with a joiner read as the atomic letter (EXP-402). */
const readKhandaTaAsDrawn = (text: string) => text.replace(LEGACY_KHANDA_TA, KHANDA_TA);

// The Gurmukhi udaat and yakash, a hook under the letter where the virama draws its stroke (Gurmukhi MN and Sangam
// MN: "ਰਾਜੑ" and "ਰਾਜੵ" like "ਰਾਜ੍"), or a dot under it (Noto Sans), which the keys drop
const GURMUKHI_HOOK_BELOW = /[\u0A51\u0A75]/gu;
const GURMUKHI_VIRAMA = "\u0A4D";

/**
 * The Gurmukhi udaat and yakash read as the virama (EXP-374). The visual keys are taken with this reading and without
 * it (similarKeys), so a name with one meets both the virama ("ਕੑਸ" next to "ਕ੍ਸ") and the bare letter, also read
 * as a sister script's ("ਠੑਧ੍" next to "ठਧ੍"), with or without the symbol table (EXP-405: "৽ਕੑਸ" next to "॰ਕਸ").
 */
const readGurmukhiHooksAsVirama = (text: string) => text.replace(GURMUKHI_HOOK_BELOW, GURMUKHI_VIRAMA);

// Code points Unicode 15.1 reserves for emoji, which names may use (see UNASSIGNED_IN_TABLES): a phone whose fonts lack
// the emoji, or any phone for those still unassigned, draws them all as the same empty box ("Ana 🫩" like "Ana 🫆").
// A fixed list, so every Node reads the same ones alike
const UNASSIGNED_EMOJI = new RegExp(codePointClass(UNASSIGNED_EMOJI_RANGES), "gu");
// What the visual keys read them as: a private-use character, which names can't use, so it only meets another of them
const EMPTY_BOX = "\uE000";

// Visual keys only (EXP-376): Mongolian vowels the Unicode Standard encodes apart for their sound but "written
// identically in all positional forms" (chapter 13.2, Mongolian; so Noto Sans Mongolian draws them but in a few words
// and places, see U_OR_UE_WRITTEN_ALIKE): U as O and UE as OE. O and OE are drawn alike only outside a word's first
// syllable (MONGOLIAN_READINGS)
const MONGOLIAN_LOOKALIKES: ReadonlyMap<string, string> = new Map([["\u1824", "\u1823"], ["\u1826", "\u1825"]]);

// Visual keys only (EXP-385, EXP-409, EXP-410): Mongolian letters drawn alike in some places of a word, which Noto Sans
// Mongolian 3.002 (the font iOS ships) and 1.04 (the font Android ships) place apart, so each font has its readings
// (MONGOLIAN_READINGS). Measured with HarfBuzz, Android's shaper, on 756,000 pairs of random words one or more of these
// letters apart and 120,000 pairs of two-word names (EXP-414, EXP-415): each reading reads a pair alike only where its
// font draws it alike. A word is a run of the letters U+1820-U+1842 with nothing next to it that could join it or
// change its shapes (MONGOLIAN_SHAPING): the Mongolian letters, the Sibe syllable boundary marker, the nirugu, the
// variation selectors, the vowel separator, the joiners and any mark (measured so in 3.002, but the Ali Gali signs
// U+1880-U+1884, the separator and the joiners, kept to be safe; names can't hold the last three). Punctuation (the
// full stop "᠃", the Manchu "᠉") and digits ("᠑") join nothing: a word next to them is read too
const MONGOLIAN_SHAPING = "[\\u1807\\u180A-\\u180F\\u1820-\\u1878\\u1880-\\u18AA\\u200C\\u200D\\p{M}]";
const MONGOLIAN_WORD = new RegExp(`(?<!${MONGOLIAN_SHAPING})[\\u1820-\\u1842]+(?!${MONGOLIAN_SHAPING})`, "gu");
const MONGOLIAN_O = "\u1823";
const MONGOLIAN_T = "\u1832";

// Letters the font readings look at, as regex sources
const MONGOLIAN_LETTER = "[\\u1820-\\u1842]";
const MONGOLIAN_VOWEL = "[\\u1820-\\u1827]";
const MONGOLIAN_VOWEL_BUT_EE = "[\\u1820-\\u1826]";
const MONGOLIAN_MASCULINE_VOWEL = "[\\u1820\\u1823\\u1824]";
const MONGOLIAN_CONSONANT = "[\\u1828-\\u1842]";
const MONGOLIAN_CONSONANT_BUT_N_D = "[\\u1829-\\u1832\\u1834-\\u1842]";
const MONGOLIAN_I = "\u1822";
const MONGOLIAN_B = "\u182A";
const MONGOLIAN_Q = "\u182C";
const MONGOLIAN_G = "\u182D";
const MONGOLIAN_Q_OR_G = `[${MONGOLIAN_Q}${MONGOLIAN_G}]`;
const MONGOLIAN_D = "\u1833";
const MONGOLIAN_U = "\u1824";
const MONGOLIAN_OE = "\u1825";
const MONGOLIAN_UE = "\u1826";
const I_OR_CONSONANT = `(?:${MONGOLIAN_I}|${MONGOLIAN_CONSONANT})`;
// Q and G take the gender of a vowel next to them (drawn one way by masculine vowels and another by feminine ones), so
// a vowel one of them looks at keeps its gender (EXP-414: measured on every context of 270,000 pairs of words one
// vowel apart): the one right after it, or with none (a G before a consonant or ending the word, a Q before a
// consonant), each font looks for it elsewhere
const Q_OR_G_LOOKING_ELSEWHERE = `(?:${MONGOLIAN_G}(?!${MONGOLIAN_VOWEL})|${MONGOLIAN_Q}(?=${MONGOLIAN_CONSONANT}))`;
const RIGHT_AFTER_Q_OR_G = `${MONGOLIAN_Q_OR_G}$`;

// iOS (EXP-385, EXP-414): OE and UE where they lose their stroke, which Unicode (chapter 13.2) writes like O and U:
// after an earlier vowel of the word ("ᠲᠣᠯᠥ" like "ᠲᠣᠯᠣ"), or ending it after two consonants or more ("ᠳᠰᠥ" like
// "ᠳᠰᠣ"); U and UE are read as O and OE first
const OE_LIKE_O_ON_IOS = new RegExp(
  `(?<=${MONGOLIAN_VOWEL}${MONGOLIAN_LETTER}*)${MONGOLIAN_OE}|(?<=^${MONGOLIAN_CONSONANT}{2,})${MONGOLIAN_OE}$`,
  "gu",
);
// iOS (EXP-414): a Q or G looking elsewhere takes the gender of the vowel before it, also past consonants and I if an
// I is right before it; one right after an I no other vowel comes before, of the next vowel past consonants and I
const SEEN_BY_Q_OR_G_BEFORE_ON_IOS = new RegExp([
  RIGHT_AFTER_Q_OR_G,
  `^${I_OR_CONSONANT}*${MONGOLIAN_I}${Q_OR_G_LOOKING_ELSEWHERE}${I_OR_CONSONANT}+$`,
].join("|"), "u");
const SEEN_BY_Q_OR_G_AFTER_ON_IOS = new RegExp(
  `^(?:${I_OR_CONSONANT}*${MONGOLIAN_I})?${Q_OR_G_LOOKING_ELSEWHERE}`,
  "u",
);
// D drawn like T: inside a word before a vowel but EE (chapter 13.2: "urtu" and "ordu" are written alike), and first
// in it before a consonant or a vowel and more letters (EXP-414), but before a G and a masculine vowel
const G_BEFORE_MASCULINE_VOWEL = `${MONGOLIAN_G}${MONGOLIAN_MASCULINE_VOWEL}`;
const D_LIKE_T_ON_IOS = new RegExp([
  `(?<=${MONGOLIAN_LETTER})${MONGOLIAN_D}(?=${MONGOLIAN_VOWEL_BUT_EE})`,
  `^${MONGOLIAN_D}(?=${MONGOLIAN_CONSONANT}|${MONGOLIAN_VOWEL}${MONGOLIAN_LETTER})(?!${G_BEFORE_MASCULINE_VOWEL})`,
].join("|"), "gu");
// iOS (EXP-409, EXP-415): words its font draws by a rule of their own, read as what they look like: "ᠤᠤ" and "ᠦᠦ"
// alike (O + U) and apart from "ᠣᠣ" and "ᠥᠥ" (a private-use character, which names can't use, only meets the other
// one), "ᠪᠦᠦ" like "ᠪᠤᠤ"
const UU_WORD_MARK = "\uE001";
const IOS_WORD_SPELLINGS: ReadonlyMap<string, string> = new Map([
  ["\u1824\u1824", UU_WORD_MARK], ["\u1826\u1826", UU_WORD_MARK], ["\u182A\u1826\u1826", "\u182A\u1824\u1824"],
]);

/** Whether no Q or G takes the gender of the vowel at `index` of a Mongolian `word` in iOS's font. */
const isGenderUnseenOnIos = (word: string, index: number) => !SEEN_BY_Q_OR_G_BEFORE_ON_IOS.test(word.slice(0, index))
  && !SEEN_BY_Q_OR_G_AFTER_ON_IOS.test(word.slice(index + 1));

/** A Mongolian `word` as iOS draws it: U and UE as O and OE, then OE and D read by their place in it. */
function readMongolianWordOnIos(word: string): string {
  const vowelsAlike = replaceChars(IOS_WORD_SPELLINGS.get(word) ?? word, MONGOLIAN_LOOKALIKES);
  return vowelsAlike
    .replace(OE_LIKE_O_ON_IOS, (oe, index: number) => (isGenderUnseenOnIos(vowelsAlike, index) ? MONGOLIAN_O : oe))
    .replace(D_LIKE_T_ON_IOS, MONGOLIAN_T);
}

// Android (EXP-410): Noto Sans Mongolian 1.04 draws OE and UE like O and U but where they keep their stroke: first in
// a word, or second after a consonant with letters after them (ONE_CONSONANT_BEFORE). After B inside a word, with
// letters after, it draws U like OE and UE, and only O apart (B_INSIDE_WORD). The word "ᠬᠦ" is drawn apart from "ᠬᠥ"
// (EXP-415)
const ROUND_VOWEL_BUT_O = /[\u1824-\u1826]/gu;
const ONE_CONSONANT_BEFORE = new RegExp(`^${MONGOLIAN_CONSONANT}$`, "u");
const B_INSIDE_WORD = new RegExp(`.${MONGOLIAN_B}$`, "u");
const Q_UE_WORD = "\u182C\u1826";
// Android (EXP-410, EXP-414): a G looking elsewhere takes the gender of the vowel right before it, of the vowel before
// a consonant but N and D if it ends the word, or past consonants and one I right before it; a G that starts the word
// or follows I, the next vowel past one consonant
const SEEN_BY_Q_OR_G_BEFORE_ON_ANDROID = new RegExp(
  `${RIGHT_AFTER_Q_OR_G}|(?:^|${MONGOLIAN_I})${MONGOLIAN_G}${MONGOLIAN_CONSONANT}$`,
  "u",
);
const SEEN_BY_G_AFTER_ON_ANDROID = new RegExp([
  `^${MONGOLIAN_G}(?!${MONGOLIAN_VOWEL})`,
  `^${MONGOLIAN_CONSONANT_BUT_N_D}${MONGOLIAN_G}$`,
  `^${MONGOLIAN_CONSONANT}+${MONGOLIAN_I}${MONGOLIAN_G}(?!${MONGOLIAN_VOWEL})`,
].join("|"), "u");
// D drawn like T there: first in a word before any letter, inside it before any vowel
const D_LIKE_T_ON_ANDROID = new RegExp(
  `^${MONGOLIAN_D}(?=${MONGOLIAN_LETTER})|(?<=${MONGOLIAN_LETTER})${MONGOLIAN_D}(?=${MONGOLIAN_VOWEL})`,
  "gu",
);

/** The U, OE or UE `vowel` at `index` of a Mongolian `word` read as the vowel Android's font draws it like. */
function readRoundVowelOnAndroid(word: string, vowel: string, index: number): string {
  if (word === Q_UE_WORD) return vowel;
  const before = word.slice(0, index);
  const after = word.slice(index + 1);
  const seenByQOrG = SEEN_BY_Q_OR_G_BEFORE_ON_ANDROID.test(before) || SEEN_BY_G_AFTER_ON_ANDROID.test(after);
  if (after && B_INSIDE_WORD.test(before)) return seenByQOrG && vowel === MONGOLIAN_U ? vowel : MONGOLIAN_OE;
  const keepsStroke = !before || (after && ONE_CONSONANT_BEFORE.test(before));
  return seenByQOrG || keepsStroke ? MONGOLIAN_LOOKALIKES.get(vowel) ?? vowel : MONGOLIAN_O;
}

/** A Mongolian `word` as Android draws it: U, OE, UE and D read by their place in it. */
const readMongolianWordOnAndroid = (word: string) => word
  .replace(ROUND_VOWEL_BUT_O, (vowel, index: number) => readRoundVowelOnAndroid(word, vowel, index))
  .replace(D_LIKE_T_ON_ANDROID, MONGOLIAN_T);

// Each reading of a Mongolian name as one font draws it: the keys take one at a time (similarKeys), since a phone
// draws every name with the same font. Each reads alike only what its font draws alike, so a name of several words
// meets another only where one font draws all of them alike (EXP-415)
const MONGOLIAN_READINGS = [
  (text: string) => text.replace(MONGOLIAN_WORD, readMongolianWordOnIos),
  (text: string) => text.replace(MONGOLIAN_WORD, readMongolianWordOnAndroid),
];

// Visual keys only (EXP-376, EXP-415): inside a Mongolian word (MONGOLIAN_WORD), the U and UE some font draws apart
// from O and OE are kept as typed: the words "ᠤᠤ", "ᠦᠦ" and "ᠪᠦᠦ" (iOS) and "ᠬᠦ" (Android), and U after B with
// letters after (Android). Any other U or UE of the word (captured) reads as O or OE
const WORDS_WITH_U_OR_UE_DRAWN_APART = [...IOS_WORD_SPELLINGS.keys(), Q_UE_WORD];
const U_OR_UE_KEPT_IN_WORD = new RegExp([
  `^(?:${WORDS_WITH_U_OR_UE_DRAWN_APART.join("|")})$`,
  `(?<=${MONGOLIAN_LETTER}${MONGOLIAN_B})${MONGOLIAN_U}(?=${MONGOLIAN_LETTER})`,
  `([${MONGOLIAN_U}${MONGOLIAN_UE}])`,
].join("|"), "gu");
// A Mongolian word (captured), or a U or UE outside one: no font reading reads those, so they all read as O and OE,
// as the Unicode Standard writes them
const MONGOLIAN_WORD_OR_U_OR_UE = new RegExp(`(${MONGOLIAN_WORD.source})|[${MONGOLIAN_U}${MONGOLIAN_UE}]`, "gu");

/** A Mongolian `word` with each U and UE read as O and OE where both fonts draw them alike. */
const readWordVowelsWrittenAlike = (word: string) => word.replace(
  U_OR_UE_KEPT_IN_WORD,
  (match, vowel?: string) => (vowel ? MONGOLIAN_LOOKALIKES.get(vowel) ?? vowel : match),
);

/** `text` with each Mongolian U and UE read as O and OE, but those a font draws apart inside a word. */
const readMongolianVowelsWrittenAlike = (text: string) => text.replace(
  MONGOLIAN_WORD_OR_U_OR_UE,
  (match, word?: string) => (word ? readWordVowelsWrittenAlike(word) : MONGOLIAN_LOOKALIKES.get(match) ?? match),
);

// Visual keys only (EXP-374): the viramas of Devanagari, Bengali, Gurmukhi, Gujarati and Oriya with no letter of their
// script after them, past marks (at the end of a word, before a space or punctuation), a tick under the letter the size
// of a nukta that marks the same name ("राजन्" and "राजन", "हनुमान्" and "हनुमान"). Before a letter they make a
// conjunct, another name ("क्ष" and "कष"); the Malayalam, Telugu, Kannada and Sinhala viramas are a bigger stroke
// anywhere
const TICK_VIRAMAS = ["\u094D", "\u09CD", "\u0A4D", "\u0ACD", "\u0B4D"];
const TICK_VIRAMA_ENDING_WORD = new RegExp(
  TICK_VIRAMAS.map((virama) => `${virama}(?!\\p{M}*[\\u200C\\u200D]?(?=\\p{L})${scriptClassOf(virama)})`).join("|"),
  "gu",
);

/**
 * Visual keys only: Indic characters drawn like a vowel sign or a letter and a sign read as those, a tick virama
 * ending a word dropped, Mongolian vowels written alike in all forms as one, emoji newer than Unicode 15.1 as one box.
 * The Mongolian vowels go first, so they find the same words as the font readings (a virama next to a run keeps it
 * out of the words).
 */
const readDrawnAlike = (text: string) => readIndicLookalikes(readMongolianVowelsWrittenAlike(text))
  .replace(TICK_VIRAMA_ENDING_WORD, "")
  .replace(UNASSIGNED_EMOJI, EMPTY_BOX);

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
 * drawn like a letter and a vowel sign as those (EXP-356: "హరి" like "వారి", "चॉदनी" like "चाँदनी"), Indic letters
 * drawn like one of a sister script as it (EXP-375: Gurmukhi "ਟ" like Devanagari "ट"), Mongolian U as O and UE as OE
 * (EXP-376: "ᠪᠤᠯ" like "ᠪᠣᠯ"), and every emoji newer than Unicode 15.1 as the same empty box, as phones without it
 * draw it ("Ana 🫩" like "Ana 🫆"). Names are also compared through other readings of them (similarKeys).
 */
export function visualKey(name: string): string {
  const voicingMarksClosed = composeHangul(readDrawnAlike(name))
    .replace(SPACE_BEFORE_SPACING_VOICING_MARK, "");
  const symbols = foldSymbols(separateVoicing(voicingMarksClosed, SYMBOL_VOICING_STAND_INS));
  const skeletal = foldSymbols(splitVoicedKana(skeleton(symbols, SYMBOL_VOICING_STAND_INS)));
  return readLetterLookalikes(skeletal);
}

/**
 * The visual key without the symbol table (EXP-285): the skeleton with only the letter groups that differ in some
 * fonts, the marks drawn like an Indic vowel sign, the Indic characters drawn like a letter and a vowel sign (EXP-356)
 * or a sister script's letter (EXP-375), the Mongolian vowels written alike (EXP-376) and the emoji newer than Unicode
 * 15.1 read alike. The symbol table reads small or circled o and zero as other symbols ("º", "ᵒ" and "⁰" as
 * the degree sign, which keeps "(º_º)" next to "(°_°)"); here NFKC reads them as the letter or digit they also look
 * like, so "b⁰b" and "b⓪b" still meet "bob", and "bºb" meets "b0b".
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

/**
 * The keys of a name read in one order: its nameKey, and its visual and letter visual keys for each of its readings
 * (similarKeys), always in the same order, so that two names compare each reading with the same one.
 */
interface OrderKeys {
  readonly same: string;
  readonly similar: readonly string[];
}

/** The keys of a name as stored and as drawn on screen (right-to-left letters reversed, see displayOrder). */
export interface NameKeys {
  readonly stored: OrderKeys;
  readonly drawn: OrderKeys;
}

/** How a name compares with another: the same name, a different one that looks too alike, or distinct. */
export type NameClash = "same" | "similar" | null;

// Ways a name may also be drawn (EXP-374, EXP-385, EXP-402, EXP-405, EXP-409, EXP-410): from each group the keys take
// none of its readings or one. A reading only adds keys, so a name still meets everything it meets as typed, also
// where a reading changes one name and not the other
const OPTIONAL_READINGS: ReadonlyArray<ReadonlyArray<(text: string) => string>> = [
  [readGurmukhiHooksAsVirama], [readChillusAsDrawn], [readKhandaTaAsDrawn], MONGOLIAN_READINGS,
];

/** `text` read with none or one reading of each OPTIONAL_READINGS group, always in the same order (as typed first). */
const readingsOf = (text: string) => OPTIONAL_READINGS.reduce(
  (readings, group) => readings.flatMap((reading) => [reading, ...group.map((read) => read(reading))]),
  [text],
);

/**
 * The visual and letter visual keys of each reading of `text` (readingsOf), in order. A reading that changes nothing
 * (most names) reuses the keys already taken.
 */
function similarKeys(text: string): readonly string[] {
  const keysOf = new Map<string, readonly string[]>();
  return readingsOf(text).flatMap((reading) => {
    const keys = keysOf.get(reading) ?? [visualKey(reading), letterVisualKey(reading)];
    keysOf.set(reading, keys);
    return keys;
  });
}

const orderKeys = (text: string): OrderKeys => ({ same: nameKey(text), similar: similarKeys(text) });

/**
 * Keys of `name` (compute once per player: see RoomManager), only for a name isValidUsername accepted: the key regexes
 * rely on its bounds (15 units, at most four stacking marks on a letter), as KEPT_VIRAMA's lookbehind is quadratic in
 * a run of marks (tests/playerNameKeysAfterValidation.integration.test.ts).
 */
export function nameKeys(name: string): NameKeys {
  return { stored: orderKeys(name), drawn: orderKeys(displayOrder(name)) };
}

/** Whether two names' keys in one order share a visual or letter visual key of the same reading (similarKeys). */
const shareSimilarKey = (a: OrderKeys, b: OrderKeys) => a.similar.some((key, reading) => key === b.similar[reading]);

/**
 * "same" when the names share a nameKey ("bob" and "BOB", "bob" with a Cyrillic o, "Milo" and "Mi" + Hebrew samekh
 * and vav, which draw as "lo"); "similar" when they only share a visualKey or a letterVisualKey of the same reading
 * (similarKeys: "Alice" and "AIice", "Clara" and "Dara", "bob" and "b⁰b", "ਕੑਸ" and "ਕ੍ਸ", "ᠲᠣᠯᠥ" and "ᠲᠣᠯᠣ").
 * Stored order is compared with stored order and drawn with drawn, so a right-to-left name never meets its reversal.
 */
export function nameClash(a: NameKeys, b: NameKeys): NameClash {
  const orders = [[a.stored, b.stored], [a.drawn, b.drawn]] as const;
  if (orders.some(([keysA, keysB]) => keysA.same === keysB.same)) return "same";
  return orders.some(([keysA, keysB]) => shareSimilarKey(keysA, keysB)) ? "similar" : null;
}

/** Whether two names are the same name (nameClash "same"). */
export function sameName(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) === "same";
}

/** Whether two names would read alike on screen (the same name or too similar). */
export function looksLike(a: string, b: string): boolean {
  return nameClash(nameKeys(a), nameKeys(b)) !== null;
}
