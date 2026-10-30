import { ASCII_CONFUSABLES, SYMBOL_CONFUSABLES } from "./asciiConfusables";
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

// Longest name in UTF-16 units: exactly what the app's name input takes (MAX_USERNAME_INPUT_LENGTH in
// Client/app/utils/protocolLimits.ts; qa/lab/tests/protocol-constants.test.sh checks they are equal)
export const MAX_USERNAME_LENGTH = 15;
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
 * characters or spaces other than U+0020, no space at either end or two in a row, no combining mark at the start or on
 * a trailing space, at most four combining marks in a row, no mark on a kana with a voiced form but the voicing mark
 * it takes (marksKanaOddly), no mix of Latin-lookalike scripts (see mixesLookalikeScripts) and no Hangul block of jamo
 * that don't make one syllable (splitsHangulBlock). Emoji, symbols, punctuation and digits are free: a name may be
 * made only of them.
 */
export function isValidUsername(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_USERNAME_LENGTH) return false;
  if (value.normalize("NFKC").length > MAX_NORMALIZED_LENGTH) return false;
  return !STRAY_SPACES.test(value)
    && !INVISIBLE.test(withoutAllowedFormatChars(value))
    && !LEADING_MARK.test(value)
    && !TRAILING_MARK.test(value)
    && !MARK_PILE.test(value)
    && !marksKanaOddly(value)
    && !mixesLookalikeScripts(value)
    && !splitsHangulBlock(value);
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

// ── Lookalike keys ──────────────────────────────────

// Marks on a letter or symbol, voicing marks aside (see withoutMarks). A mark on a space stays: NFKC turns spacing
// accents (the arms of "¯\_(ツ)_/¯", ´, ¨) into a space plus a mark, and that mark is all they draw
const COMBINING_MARK = /(?<!\s)(?![\u3099\u309A])\p{Mn}/gu;
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
 * marks on a letter or symbol dropped (but a voicing mark on a kana that takes it, or on a letter that `standIns` reads
 * as one), conjoining jamo still on their own read as compatibility letters, the table again for what NFKC and the
 * marks uncovered, joiners dropped, whitespace trimmed and collapsed. The table runs before NFKC too because NFKC can
 * lose the look: long s reads as "f" but NFKC turns it into "s".
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
 * the kana.
 */
export function visualKey(name: string): string {
  const voicingMarksClosed = composeHangul(name).replace(SPACE_BEFORE_SPACING_VOICING_MARK, "");
  const symbols = foldSymbols(separateVoicing(voicingMarksClosed, SYMBOL_VOICING_STAND_INS));
  const skeletal = foldSymbols(splitVoicedKana(skeleton(symbols, SYMBOL_VOICING_STAND_INS)));
  const folded = toAscii(foldCase(skeletal.replace(LOOKS_LIKE_L, "l")));
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
 * "same" when the names share a nameKey ("bob" and "BOB", "bob" with a Cyrillic o, "Milo" and "Mi" + Hebrew samekh
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
