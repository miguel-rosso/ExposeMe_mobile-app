#!/usr/bin/env node
// Regenerates Server/managers/asciiConfusables.ts (EXP-032) from Unicode's confusables.txt (UTS #39):
//   curl -o /tmp/confusables.txt https://www.unicode.org/Public/security/latest/confusables.txt
//   node Server/scripts/generateAsciiConfusables.mjs /tmp/confusables.txt > Server/managers/asciiConfusables.ts
// Run it with the oldest Node the server supports (20.x, Unicode 15.1; the generated header records the version): the
// output depends on Node's Unicode data (NFKC, character categories), and characters a newer Unicode adds are left out
// of the symbol table, so the tables read the same on every newer Node.
// UNASSIGNED_NON_EMOJI_RANGES (EXP-284) lists the code points this Unicode version leaves unassigned but those it
// reserves for emoji: playerName refuses them in names, so a newer Node never accepts a letter the tables don't know
// (one drawn like a letter they read), while a newer emoji, which the tables leave out anyway, is fine on every Node.
// UNASSIGNED_EMOJI_RANGES lists those reserved ones: the visual keys read them all alike, as phones that lack them
// draw the same empty box. EXTENDED_PICTOGRAPHIC_RANGES lists this version's emoji, assigned or reserved, which may
// carry an emoji joiner or presentation selector in a name: Unicode 17 took 689 of them out of the property, so the
// running Node's \p{Extended_Pictographic} would accept "★" + emoji selector on Node 20 and refuse it on Node 24.
//
// Keeps every character, whatever its script or category (letters, math and box-drawing symbols, punctuation such as
// an inverted exclamation mark), whose prototype is 1-3 ASCII letters or digits once combining marks are dropped and
// Latin small capitals are read as their letter. Left out: ASCII itself (playerName.visualKey handles 1/l/I/0),
// nonspacing marks and characters that decompose to one (playerName drops them, but Indic vowel signs, which are drawn
// like no ASCII letter; spacing marks such as the Telugu anusvara are drawn like an "o" and kept), and characters that
// NFKC with marks dropped already turns into their prototype (playerName applies NFKC after this table).
// confusables.txt often lists only the capital (Cyrillic KA as "K", Greek MU as "M"): the lowercase letter, when it
// has no entry of its own, is added with the lowercase prototype ("к" as "k"), as the player sees the same shape.
// Except under an "l" prototype: capitals drawn like I share it with l, but their lowercase looks like an i (small
// Roman numeral one, full-width i, ij ligature; NFKC already reads most of them).
//
// SYMBOL_CONFUSABLES (EXP-268), for playerName.visualKey only: symbols drawn like other symbols. Keeps every character
// whose prototype has no letters or digits other than modifier letters ("∙" as "•", "ǃ" as "!", "’" as "'", "¯"
// as "ˉ", "一" and "ㅡ" as "ー"), every punctuation mark or symbol whatever its prototype ("—" and "―" as "ー"), and
// (EXP-317) the letters UTS #39 draws like a kana or a kana draws like ("カ" as "力", "ロ" as "口", "ヘ" as "へ", "朩"
// as "ホ"), which are letters of words but read as one another in a name; so (EXP-321) are the ideographs of the CJK
// Unified Ideographs block and its Extension A that UTS #39 draws alike: simplified, traditional and Japanese forms
// ("吴", "吳" and "呉"; "兑" and "兌") and near twins ("囗" and "口", "士" and "土"). Later extensions are left out:
// fonts often lack them, so they don't reliably draw like anything.
// Each prototype is written as playerName's skeleton reads it (ASCII table, NFKC, combining marks dropped), so a name
// typed with it gets the same key; playerName applies the table before NFKC too, which turns "¯" into a space and a
// mark. Left out: ASCII letters and digits, ASCII_CONFUSABLES sources, marks (Indic vowel signs are letters of a
// word), colour emoji (🍎 and 🍏 differ by colour), spaces, characters NFKC already reads as the prototype,
// prototypes that lose marks in the skeleton or that have cased letters (visualKey folds case after the table, which
// would join "∑" and "∫"), cased letters whose other case reads differently, characters newer than the generating
// Node's Unicode, and symbols of a clearly different size (SIZE_PROTOTYPES).
//
// INDIC_CONFUSABLES (EXP-364), for playerName's visual keys only: characters of the Indic scripts and Sinhala
// (U+0900-0DFF) drawn like another spelling of their own script ("௧" as "க", "റ" as "ര", "൬" as "ന്ന", "హ" as
// "వా"), Kannada and Telugu counted as one script (UTS #39 draws most of their letters alike: "ಅ" as "అ"). Left out:
// characters the tables above read, composed characters (playerName decomposes Indic text first, so their parts are
// read), prototypes holding a character of another script, a mark of none or one newer than the generating Node (no
// name spells them: Telugu "భ" as "బ" + a Latin dot below, Devanagari "आ" as "अ" + a Nandinagari sign), and letters
// whose prototype holds a virama: the name keys drop it, so the letter would read as bare consonants it is not drawn
// like (Malayalam chillu L as LA + virama would put "കമൽ" next to "കമല"). Other characters keep it: digits and
// symbols, which real names don't hold ("൬" as "ന്ന"). Across scripts (EXP-375), only the pairs of
// CROSS_SCRIPT_INDIC, reviewed one by one: Gurmukhi "ਟ" as Devanagari "ट", Malayalam "ഖ" as Tamil "வ".
import { readFileSync } from "fs";

const ASCII_PROTOTYPE = /^[A-Za-z0-9]{1,3}$/;
const COMBINING_MARKS = /\p{Mn}/gu;
const NONSPACING_MARK = /\p{Mn}/u;
// confusables.txt lines: "source ;\tprototype ;\tMA\t#[*] ( source → prototype ) SOURCE NAME → PROTOTYPE NAMES\t#...",
// the prototype names separated by ", ", then the characters UTS #39 drew the source like on the way to its
// prototype, if any ("\t# \u2192\u0AE8\u2192" for the Gujarati letter RA, drawn like the Gujarati digit two)
const ENTRY = /^([0-9A-F]+) ;\t([0-9A-F ]+) ;\tMA\t#\*? \( .+ \) (.+?) \u2192 ([^\t]*)(?:\t#\s*(.*))?/;

// Latin small capitals (U+1D00-1D22 and the IPA ones) are their own prototype in confusables.txt: read them as the letter
const SMALL_CAPITALS = {
  "\u1D00": ["a", "LATIN LETTER SMALL CAPITAL A"],
  "\u1D03": ["b", "LATIN LETTER SMALL CAPITAL BARRED B"],
  "\u1D04": ["c", "LATIN LETTER SMALL CAPITAL C"],
  "\u1D05": ["d", "LATIN LETTER SMALL CAPITAL D"],
  "\u1D06": ["d", "LATIN LETTER SMALL CAPITAL ETH"],
  "\u1D07": ["e", "LATIN LETTER SMALL CAPITAL E"],
  "\u1D0A": ["j", "LATIN LETTER SMALL CAPITAL J"],
  "\u1D0B": ["k", "LATIN LETTER SMALL CAPITAL K"],
  "\u1D0C": ["l", "LATIN LETTER SMALL CAPITAL L WITH STROKE"],
  "\u1D0D": ["m", "LATIN LETTER SMALL CAPITAL M"],
  "\u1D0F": ["o", "LATIN LETTER SMALL CAPITAL O"],
  "\u1D18": ["p", "LATIN LETTER SMALL CAPITAL P"],
  "\u1D1B": ["t", "LATIN LETTER SMALL CAPITAL T"],
  "\u1D1C": ["u", "LATIN LETTER SMALL CAPITAL U"],
  "\u1D20": ["v", "LATIN LETTER SMALL CAPITAL V"],
  "\u1D21": ["w", "LATIN LETTER SMALL CAPITAL W"],
  "\u1D22": ["z", "LATIN LETTER SMALL CAPITAL Z"],
  "\u0262": ["g", "LATIN LETTER SMALL CAPITAL G"],
  "\u026A": ["i", "LATIN LETTER SMALL CAPITAL I"],
  "\u0274": ["n", "LATIN LETTER SMALL CAPITAL N"],
  "\u0280": ["r", "LATIN LETTER SMALL CAPITAL R"],
  "\u028F": ["y", "LATIN LETTER SMALL CAPITAL Y"],
  "\u0299": ["b", "LATIN LETTER SMALL CAPITAL B"],
  "\u029C": ["h", "LATIN LETTER SMALL CAPITAL H"],
  "\u029F": ["l", "LATIN LETTER SMALL CAPITAL L"],
  "\uA730": ["f", "LATIN LETTER SMALL CAPITAL F"],
  "\uA731": ["s", "LATIN LETTER SMALL CAPITAL S"],
};

const stripMarks = (text) => text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
const asAscii = (text) => Array.from(stripMarks(text), (char) => SMALL_CAPITALS[char]?.[0] ?? char).join("");
const escape = (char) => `\\u${char.codePointAt(0) <= 0xffff ? char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") : `{${char.codePointAt(0).toString(16).toUpperCase()}}`}`;

const [, , sourcePath] = process.argv;
if (!sourcePath) {
  console.error("usage: node generateAsciiConfusables.mjs <confusables.txt>");
  process.exit(2);
}
const text = readFileSync(sourcePath, "utf8");
const version = text.match(/^# Version: (.+)$/m)?.[1] ?? "unknown";

/**
 * The MA entries of confusables.txt: source character, raw prototype, the source's name, the prototype's names and the
 * characters UTS #39 drew the source like on the way to the prototype.
 */
const confusables = text.split("\n").flatMap((line) => {
  const match = line.match(ENTRY);
  if (!match) return [];
  const source = String.fromCodePoint(parseInt(match[1], 16));
  const prototype = String.fromCodePoint(...match[2].trim().split(" ").map((hex) => parseInt(hex, 16)));
  const steps = (match[5] ?? "").split("\u2192").map((step) => step.trim()).filter(Boolean);
  return [{ source, prototype, name: match[3], prototypeNames: match[4].split(", "), steps }];
});

// ── ASCII_CONFUSABLES ───────────────────────────────

/** Whether `source` belongs in the table with this ASCII prototype (see the header for what is left out). */
const keeps = (source, prototype) => source.codePointAt(0) > 0x7f && !NONSPACING_MARK.test(source)
  && stripMarks(source) === source && ASCII_PROTOTYPE.test(prototype)
  && stripMarks(source.normalize("NFKC")) !== prototype;

const entries = new Map(Object.entries(SMALL_CAPITALS));
for (const { source, prototype: raw, name } of confusables) {
  const prototype = asAscii(raw);
  if (keeps(source, prototype) && !entries.has(source)) entries.set(source, [prototype, name]);
}

// Lowercase letters only listed through their capital, added once every entry of its own is in
for (const [source, [prototype, name]] of [...entries]) {
  const lower = source.toLowerCase();
  const lowerPrototype = prototype.toLowerCase();
  if (lower === source || [...lower].length !== 1 || entries.has(lower) || prototype.includes("l")) continue;
  if (!keeps(lower, lowerPrototype)) continue;
  entries.set(lower, [lowerPrototype, `lowercase of ${name}`]);
}

// ── SYMBOL_CONFUSABLES ──────────────────────────────

const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
// Letters and digits make a prototype a word; modifier letters don't: "ー" and "ˉ" are strokes
const WORD_CHARACTER = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}]/u;
const UNASSIGNED = /\p{Cn}/u;
const ANY_MARK = /\p{M}/u;
// Emoji (other than ASCII digits, "#" and "*") may be drawn in colour: "🍎" and "🍏" differ by colour only. Emoji, not
// Extended_Pictographic: Unicode 17 took "☐" and "♩" out of the latter, so Node 20 and 24 would disagree
const EMOJI = /(?![\0-\x7F])\p{Emoji}/u;
const WHITESPACE = /\s/u;
const ASCII_ALPHANUMERIC = /^[A-Za-z0-9]$/;
const LETTER = /^\p{L}$/u;
const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;

/** A letter drawn like a letter, one of them a kana (UTS #39: "カ" as "力", "ヘ" as "へ", "朩" as "ホ"). */
const isKanaLookalike = (source, prototype) => LETTER.test(source) && LETTER.test(prototype)
  && (KANA.test(source) || KANA.test(prototype));

// CJK Unified Ideographs Extension A and the main block
const COMMON_IDEOGRAPH = /^[\u3400-\u4DBF\u4E00-\u9FFF]$/u;

/** An ideograph drawn like another one, both common (UTS #39: "吴" as "吳", "囗" as "口"). */
const isIdeographLookalike = (source, prototype) => COMMON_IDEOGRAPH.test(source) && COMMON_IDEOGRAPH.test(prototype);

// Drawn size (EXP-268): UTS #39 joins symbols of one shape whatever their size, but a clearly bigger, smaller or
// bolder glyph reads as a different name. Measured ink boxes (Roboto and Noto Sans Symbols on Android, SF on iOS, in
// em) split these groups; each source gets the prototype of its size group, or itself when it has a size of its own.
const SIZE_PROTOTYPES = new Map([
  // Dots: the bullet and the bullet operator (0.17-0.20) are twice the middle dot (0.11), which keeps the other dots
  ["\u2022", "\u2022"], ["\u2219", "\u2022"],
  // Katakana middle dot: bullet-sized but centred in a full-width cell, so "(・_・)" spreads wider than "(•_•)"
  ["\u30FB", "\u30FB"], ["\uFF65", "\u30FB"],
  // Circles: white circles (0.41-0.79) are bigger than the degree sign (0.25-0.29); the white bullet and ring
  // operator are degree-sized but sit at mid height instead of raised
  ["\u25CB", "\u25CB"], ["\uFFEE", "\u25CB"], ["\u26AC", "\u26AC"], ["\u25E6", "\u25E6"], ["\u2218", "\u2218"],
  // Squares: full block (0.71 x 1.21), black square (0.60) and small square (0.18-0.25) against end of proof (0.46)
  ["\u2588", "\u2588"], ["\u25A0", "\u25A0"], ["\uFFED", "\u25A0"], ["\u25AA", "\u25AA"],
  // Dashes: en dash, minus and figure dash (0.41-0.55) are twice the hyphen (0.24-0.31) and shorter than the em
  // dash group (0.65-1.01); the heavy box line is twice as thick; the full-width hyphen-minus is a hyphen-long
  // stroke (0.24) in a full-width cell, not the long bar of "ー" (NFKC already reads it as "-")
  ["\u2013", "\u2013"], ["\u2212", "\u2013"], ["\u2012", "\u2013"], ["\u2501", "\u2501"], ["\uFF0D", "\uFF0D"],
  // Overline: the upper one eighth block (0.71-0.80) is twice the macron (0.33)
  ["\u2594", "\u2594"],
  // Tildes: the small tilde (0.29-0.35, raised) is half the tilde (0.48-0.55, mid height); the wave dash is 0.92
  ["\u02DC", "\u02DC"], ["\u301C", "\u301C"],
  // Asterisks (EXP-286): the asterisk is raised (0.30-0.76 em above the baseline); the low asterisk hangs from the
  // baseline (-0.20-0.28), and the asterisk operator and the Arabic five pointed star sit low too (SF, Apple Symbols,
  // Geeza Pro, Noto Sans Math, Noto Naskh and Noto Sans Arabic: -0.05-0.53). The triangles stay one group: fonts
  // without the small triangle and the pointer (SF has neither) draw them as big as the black triangle
  ["\u204E", "\u204E"], ["\u2217", "\u204E"], ["\u066D", "\u204E"],
  // Ideographs (EXP-321, PingFang and Hiragino on iOS, Noto Sans CJK on Android): the grass radical "艹" is a flat top
  // part (0.32-0.37 high), "卄" and "卝" fill the cell (0.90). Closer sizes stay alike, as the kana lookalikes do: the
  // enclosure "囗" is 7-12% bigger than "口", "曰" a little wider and shorter than "日"
  ["\u5344", "\u5344"], ["\u535D", "\u535D"],
]);

const toAscii = (text) => Array.from(text, (char) => entries.get(char)?.[0] ?? char).join("");
/** `text` as playerName.skeleton reads it (no spaces here, so every combining mark goes). */
const skeletonOf = (text) => toAscii(stripMarks(toAscii(text).normalize("NFKC")));
/** Whether the skeleton keeps every mark of `text` ("-" with a dot above loses its dot). */
const keepsMarks = (text) => skeletonOf(text) === toAscii(toAscii(text).normalize("NFKC"));
const isCased = (text) => text.toLowerCase() !== text.toUpperCase();

/**
 * Whether `source` may be read as `rawPrototype`, whose skeleton is `prototype`: see the header. Unassigned characters
 * (newer than this Node's Unicode) are left out, so the table reads the same on every Node from the one that
 * generated it.
 */
const keepsSymbol = (source, rawPrototype, prototype) => !ASCII_ALPHANUMERIC.test(source)
  && !entries.has(source) && !ANY_MARK.test(source) && !EMOJI.test(source) && !WHITESPACE.test(source)
  && !UNASSIGNED.test(source + rawPrototype) && keepsMarks(rawPrototype)
  && prototype !== "" && prototype !== skeletonOf(source) && !WHITESPACE.test(prototype) && !isCased(prototype)
  && (PUNCTUATION_OR_SYMBOL.test(source) || !WORD_CHARACTER.test(prototype) || isKanaLookalike(source, prototype)
    || isIdeographLookalike(source, prototype));

const symbols = new Map();
for (const { source, prototype: raw, name } of confusables) {
  const sized = SIZE_PROTOTYPES.get(source) ?? raw;
  if (symbols.has(source) || !keepsSymbol(source, sized, skeletonOf(sized))) continue;
  symbols.set(source, [skeletonOf(sized), name]);
}

// A cased letter stays only when its other case reads the same: visualKey folds case after this table, so "ɁɁ"
// can't look like "??" while "ɂɂ", the same name in lowercase, doesn't
const readsAs = (text) => symbols.get(text)?.[0] ?? skeletonOf(text);
const caseMismatches = [...symbols].filter(([source, [prototype]]) => isCased(source)
  && [source.toLowerCase(), source.toUpperCase()].some((other) => readsAs(other) !== prototype));
for (const [source] of caseMismatches) symbols.delete(source);

// UTS #39 prototypes are never sources themselves, so a prototype is already its own key. Checked here because the
// skeleton and the size groups may have rewritten it: a typed prototype must not be folded again by playerName.
for (const [source, [prototype]] of symbols) {
  if (Array.from(prototype).some((char) => symbols.has(char)) || skeletonOf(prototype) !== prototype) {
    console.error(`prototype of ${escape(source)} is not its own key: ${prototype}`);
    process.exit(1);
  }
}

// ── INDIC_CONFUSABLES ───────────────────────────────

// The Indic scripts and Sinhala have a block of 128 code points each, from U+0900 (Devanagari) to U+0DFF (Sinhala)
const INDIC_CHAR = /^[\u0900-\u0DFF]$/u;
const INDIC_BLOCK_SIZE = 0x80;
const TELUGU_BLOCK = 0x0c00 / INDIC_BLOCK_SIZE;
const KANNADA_BLOCK = 0x0c80 / INDIC_BLOCK_SIZE;
// The viramas of these scripts, as confusables.txt names them ("MALAYALAM SIGN VIRAMA", "SINHALA SIGN AL-LAKUNA")
const VIRAMA_NAME = / SIGN (?:VIRAMA|AL-LAKUNA)$/;

/** The script of an Indic character: its block, Kannada counted as Telugu. */
const indicScriptOf = (char) => {
  const block = Math.floor(char.codePointAt(0) / INDIC_BLOCK_SIZE);
  return block === KANNADA_BLOCK ? TELUGU_BLOCK : block;
};

/**
 * Whether `source` may read in the Indic table as `prototype`, named `prototypeNames`, whatever their scripts (see the
 * header).
 */
const keepsIndicAnyScript = (source, prototype, prototypeNames) => INDIC_CHAR.test(source)
  && source.normalize("NFD") === source && !entries.has(source) && !symbols.has(source)
  && !UNASSIGNED.test(source + prototype) && Array.from(prototype).every((char) => INDIC_CHAR.test(char))
  && !(LETTER.test(source) && prototypeNames.some((name) => VIRAMA_NAME.test(name)));

/** Whether `source` reads in the Indic table as `prototype`, a spelling of its own script (see the header). */
const keepsIndic = (source, prototype, prototypeNames) => keepsIndicAnyScript(source, prototype, prototypeNames)
  && Array.from(prototype).every((char) => indicScriptOf(char) === indicScriptOf(source));

// Cross-script lookalikes (EXP-375), reviewed one by one: source → the character it is read as, the UTS #39
// prototype or one of the steps UTS #39 went through. Kept only when they render essentially alike in the fonts the
// app uses (Gurmukhi MN, Kohinoor and the Sangam fonts on iOS, Noto Sans on Android, compared at large size): sister
// scripts share many shapes that are close but not the same, and joining those would put real names of two scripts
// next to each other. A name may mix Indic scripts letter by letter (only a vowel sign must match its letter's
// script), so one swapped letter is enough to copy a name.
const CROSS_SCRIPT_INDIC = new Map([
  // Gurmukhi letters drawn like a Devanagari letter, with the same headline: TA like U, TTA like TTA, TTHA like TTHA,
  // PHA like DDHA (an angular top for a rounded one) and SA like MA. Left out: DHA like PA (a hook on the stem),
  // MA like BHA (Noto Sans Devanagari curls BHA), KA like VA (an open curl for a closed bowl) and VA like HA
  ["\u0A24", "\u0909"], ["\u0A1F", "\u091F"], ["\u0A20", "\u0920"], ["\u0A2B", "\u0922"], ["\u0A38", "\u092E"],
  // Gurmukhi vowel signs drawn like Devanagari ones on those letters: AI like AI, and Gurmukhi and Devanagari I both
  // like the Bengali I they meet at (playerName measures the II and EE signs, which UTS #39 doesn't list). Left out:
  // OO like the curved short E, which playerName reads as E, so OO would meet the Gurmukhi EE sign it is drawn apart
  // from ("\u0A38\u0A4B\u0A39\u0A28" and "\u0A38\u0A47\u0A39\u0A28" are different names)
  ["\u0A48", "\u0948"], ["\u0A3F", "\u09BF"], ["\u093F", "\u09BF"],
  // Gujarati digits four and eight and the avagraha, drawn like the Devanagari ones; and (UTS #39 step) the Gujarati
  // letter RA like the Gujarati digit two. Left out: the Gujarati digit two like the Devanagari one, whose tail is a
  // straight stroke, and the Gujarati vowel signs and virama, which no Gujarati letter drawn like Devanagari carries
  ["\u0AEA", "\u096A"], ["\u0AEE", "\u096E"], ["\u0ABD", "\u093D"], ["\u0AB0", "\u0AE8"],
  // Malayalam THA and KHA drawn like Tamil MA and VA, and the Malayalam vowel sign I like the Tamil one. Left out:
  // U, UU, JA, TTTA, NNA, LLLA and SHA (other curls or a tail), the E, EE and AI signs and the letter AI (the Tamil
  // signs rise above the letters) and the II sign, which would also read Malayalam I and II alike
  ["\u0D25", "\u0BAE"], ["\u0D16", "\u0BB5"], ["\u0D3F", "\u0BBF"],
]);

const indic = new Map();
for (const { source, prototype, name, prototypeNames } of confusables) {
  if (!indic.has(source) && keepsIndic(source, prototype, prototypeNames)) indic.set(source, [prototype, name]);
}
// A reviewed pair must still be in UTS #39 (or the generator stops): a newer confusables.txt may draw it otherwise
for (const [source, reviewed] of CROSS_SCRIPT_INDIC) {
  const entry = confusables.find((candidate) => candidate.source === source);
  const fromUts = entry && (entry.prototype === reviewed || entry.steps.includes(reviewed));
  const names = entry?.prototype === reviewed ? entry.prototypeNames : [];
  if (!fromUts || indic.has(source) || !keepsIndicAnyScript(source, reviewed, names)) {
    console.error(`cross-script Indic lookalike ${escape(source)} is not an Indic entry of UTS #39 to review`);
    process.exit(1);
  }
  indic.set(source, [reviewed, entry.name]);
}

// playerName reads the table once, on decomposed text: a prototype must already be decomposed and read as itself
for (const [source, [prototype]] of indic) {
  if (prototype.normalize("NFD") !== prototype || Array.from(prototype).some((char) => indic.has(char))) {
    console.error(`Indic prototype of ${escape(source)} is not its own key: ${Array.from(prototype, escape).join("")}`);
    process.exit(1);
  }
}

// ── Unassigned ranges ───────────────────────────────

const LAST_CODE_POINT = 0x10ffff;
// Emoji, and the code points Unicode reserves for future ones (Extended_Pictographic while still unassigned). Taken
// from this Node's Unicode and written into the tables, as newer versions take some of them out of the property
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** Whether this Node's Unicode leaves `codePoint` unassigned (general category Cn) and not reserved for an emoji. */
const isUnassignedNonEmoji = (codePoint) => {
  const char = String.fromCodePoint(codePoint);
  return UNASSIGNED.test(char) && !EXTENDED_PICTOGRAPHIC.test(char);
};

/** Whether this Node's Unicode counts `codePoint` as an emoji, assigned or reserved (Extended_Pictographic). */
const isExtendedPictographic = (codePoint) => EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint));

/** Whether this Node's Unicode leaves `codePoint` unassigned but reserves it for an emoji. */
const isUnassignedEmoji = (codePoint) => {
  const char = String.fromCodePoint(codePoint);
  return UNASSIGNED.test(char) && EXTENDED_PICTOGRAPHIC.test(char);
};

/** The code points that satisfy `predicate`, as [first, last] ranges. */
function rangesOf(predicate) {
  const ranges = [];
  let first = null;
  for (let codePoint = 0; codePoint <= LAST_CODE_POINT + 1; codePoint += 1) {
    const included = codePoint <= LAST_CODE_POINT && predicate(codePoint);
    if (included && first === null) first = codePoint;
    if (!included && first !== null) {
      ranges.push([first, codePoint - 1]);
      first = null;
    }
  }
  return ranges;
}

// ── Output ──────────────────────────────────────────

/** `text` as the body of a double-quoted TypeScript string: printable ASCII as is, anything else escaped. */
const quote = (text) => Array.from(text, (char) => (/^[\x20-\x7E]$/.test(char) && char !== "\"" && char !== "\\"
  ? char
  : escape(char))).join("");
const byCodePoint = ([a], [b]) => a.codePointAt(0) - b.codePointAt(0);
/** A read-only Map (no prototype keys such as "constructor" to look up by mistake). */
const mapLines = (exportName, table) => [
  `export const ${exportName}: ReadonlyMap<string, string> = new Map<string, string>([`,
  ...[...table].sort(byCodePoint)
    .map(([source, [prototype, name]]) => `  ["${escape(source)}", "${quote(prototype)}"], // ${name}`),
  "]);",
];

const hex = (codePoint) => `0x${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
const RANGES_PER_LINE = 6;
/** [first, last] code point ranges, a few per line. */
const rangeLines = (exportName, ranges) => [
  `export const ${exportName}: ReadonlyArray<readonly [number, number]> = [`,
  ...Array.from({ length: Math.ceil(ranges.length / RANGES_PER_LINE) }, (_, line) => `  ${ranges
    .slice(line * RANGES_PER_LINE, (line + 1) * RANGES_PER_LINE)
    .map(([first, last]) => `[${hex(first)}, ${hex(last)}],`)
    .join(" ")}`),
  "];",
];

const out = [
  `// Generated by Server/scripts/generateAsciiConfusables.mjs from Unicode confusables.txt ${version} (UTS #39)`,
  `// with Node ${process.version} (Unicode ${process.versions.unicode}). Do not edit.`,
  "",
  "// Character \u2192 the ASCII letters or digits it is drawn like (letters of any script, symbols, punctuation).",
  ...mapLines("ASCII_CONFUSABLES", entries),
  "",
  "// Character \u2192 the symbols or kana it is drawn like, as the name skeleton reads them (bullets, dashes, quotes,",
  "// kana and the kanji drawn like them, ideographs drawn alike...).",
  ...mapLines("SYMBOL_CONFUSABLES", symbols),
  "",
  "// Indic character \u2192 the spelling of its script it is drawn like, decomposed (Kannada read as Telugu), or the",
  "// reviewed character of a sister script (Gurmukhi \u2192 Devanagari, Gujarati \u2192 Devanagari, Malayalam \u2192 Tamil):",
  "// for the visual keys, which read it on decomposed Indic text (playerName.readIndicLookalikes).",
  ...mapLines("INDIC_CONFUSABLES", indic),
  "",
  `// Code points unassigned in Unicode ${process.versions.unicode}, the version of the tables above, but those reserved`,
  "// for emoji (Extended_Pictographic), as [first, last] ranges: names may only use characters the tables know, or",
  "// emoji, which they leave out (playerName.isValidUsername).",
  ...rangeLines("UNASSIGNED_NON_EMOJI_RANGES", rangesOf(isUnassignedNonEmoji)),
  "",
  `// Code points unassigned in Unicode ${process.versions.unicode} but reserved for emoji, as [first, last] ranges: names`,
  "// may use them, but a phone without the emoji draws them all as the same empty box (playerName.visualKey).",
  ...rangeLines("UNASSIGNED_EMOJI_RANGES", rangesOf(isUnassignedEmoji)),
  "",
  `// Code points Unicode ${process.versions.unicode} counts as emoji, assigned or reserved (Extended_Pictographic), as`,
  "// [first, last] ranges: those that may carry an emoji joiner or presentation selector (playerName.isValidUsername).",
  ...rangeLines("EXTENDED_PICTOGRAPHIC_RANGES", rangesOf(isExtendedPictographic)),
  "",
];
process.stdout.write(out.join("\n"));
