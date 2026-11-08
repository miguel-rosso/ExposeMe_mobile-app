import { describe, expect, it } from "vitest";
import { isValidUsername, looksLike, nameKey, sameName, visualKey } from "../managers/playerName";

// EXP-032: names that read the same on screen must not coexist in a room, and invisible characters, unusual spaces,
// mark piles and mixes of Latin-lookalike scripts are refused. Emoji, symbols, ASCII art and any other script mix are
// free (DEC-033). Every non-ASCII character is written as an escape on purpose.

describe("isValidUsername", () => {
  it.each([
    ["plain", "bob"],
    ["inner space", "Ana Mar\u00EDa"],
    ["diaeresis", "Zo\u00EB"],
    ["Han", "\u674E\u96F7"],
    ["Hangul", "\uAE40\uCCA0\uC218"],
    ["Japanese with Latin", "\u3055\u304F\u3089 Sakura"],
    ["all-Greek name", "\u039D\u03AF\u03BA\u03BF\u03C2"],
    ["all-Cyrillic name", "\u0418\u0432\u0430\u043D"],
    ["Latin with a flag", "Jos\u00E9 \u{1F1EA}\u{1F1F8}"],
    ["flag first", "\u{1F1EA}\u{1F1F8} Jose"],
    ["emoji ZWJ sequence (woman technologist)", "\u{1F469}\u200D\u{1F4BB} dev"],
    ["emoji ZWJ sequence with skin tone", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB} ana"],
    ["rainbow flag (VS + ZWJ)", "ana \u{1F3F3}\uFE0F\u200D\u{1F308}"],
    ["emoji presentation selector (red heart)", "\u2764\uFE0F ana"],
    ["keycap one", "1\uFE0F\u20E3 uno"],
    ["subdivision flag (England), 15 UTF-16 units", "a\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["two combining marks", "a\u0301\u0323na"],
    ["Tibetan with three stacked marks (Drolma)", "\u0F66\u0F92\u0FB2\u0F7C\u0F63\u0F0B\u0F58"],
    ["pointed Hebrew with three marks", "\u05E9\u05B8\u05BC\u05C1"],
    ["four combining marks in a row", "bo\u0301\u0301\u0301\u0301b"],
    // EXP-454: Burmese vowel signs are spacing marks (Mc), drawn beside the letter: they never count towards a pile
    ["Burmese word with five marks, two of them stacking", "\u101C\u103B\u103E\u1031\u102C\u1037"],
    ["two Burmese words", "\u101C\u103B\u103E\u1031\u102C\u1037\u1001\u103B"],
    ["four stacking marks with spacing marks between", "\u101C\u1036\u103B\u1036\u1031\u1036\u1036"],
    ["Sinhala Sri with a zero-width joiner", "\u0DC1\u0DCA\u200D\u0DBB\u0DD3"],
    ["Persian with a zero-width non-joiner", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"],
    ["Devanagari half form with a zero-width joiner", "\u0915\u094D\u200D\u0937"],
    ["mark on a space between symbols", "( \u0361\u00B0)"],
    ["Arabic with tatweel", "\u0639\u0640\u0644\u064A"],
    // The app's name input takes 15 characters, and the server as many (DEC-043)
    ["15 characters", "a".repeat(15)],
    // Emoji, symbols, punctuation and ASCII art, with no letter at all or with letters of one script (DEC-033)
    ["emoji only", "\u{1F600}"],
    ["repeated emoji", "\u{1F525}\u{1F525}"],
    ["punctuation only", "!!"],
    ["starts with punctuation", ".bob"],
    ["hearts", "<3 <3"],
    ["kaomoji", "(\u2022_\u2022)"],
    ["shrug (Katakana with ASCII punctuation)", "\u00AF\\_(\u30C4)_/\u00AF"],
    ["lenny face (marks on spaces, Latin letter)", "( \u0361\u00B0 \u035C\u0296 \u0361\u00B0)"],
    ["bear (Latin letters with bullets)", "\u0295\u2022\u1D25\u2022\u0294"],
    ["table flip", "(\u256F\u00B0\u25A1\u00B0)\u256F\uFE35 \u253B\u2501\u253B"],
    ["digits only", "007"],
    ["tatweel only", "\u0640\u0640"],
    ["text presentation selector (heart as text)", "\u2764\uFE0E"],
    // Only letters that read as Latin count for the mix: other Greek/Cyrillic letters and other scripts are free
    ["Greek sigma in a kaomoji", "\u03A3(\uFF9F\u0414\uFF9F)"],
    ["Latin click with Cyrillic de", "(\u0298\u0414\u0298)"],
    ["Greek lowercase name drawn like Latin", "\u039C\u03B9\u03BA\u03B5"],
    ["three Arabic ligatures (54 letters after NFKC)", "\uFDFA\uFDFA\uFDFA"],
    ["Latin with Cyrillic zhe", "Dave \u0416"],
    ["Latin with Arabic", "Ahmed \u0623\u062D\u0645\u062F"],
    ["kaomoji mixing Kannada with Katakana and Han", "(\u30CE\u0CA0\u76CA\u0CA0)\u30CE"],
    ["Latin with Han", "Li \u674E"],
    ["Latin with Hangul", "Kim \uAE40"],
    ["Latin with Devanagari", "Raj \u0930\u093E\u091C"],
    ["Greek with Hiragana", "\u039D\u03AF\u03BA\u03BF\u03C2 \u3055\u304F\u3089"],
  ])("accepts %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    ["zero-width space", "bob\u200B"],
    ["zero-width joiner outside an emoji", "b\u200Dob"],
    ["zero-width non-joiner", "bo\u200Cb"],
    ["word joiner", "bob\u2060"],
    ["BOM", "\uFEFFbob"],
    ["right-to-left override", "\u202Ebob"],
    ["left-to-right isolate", "\u2066bob\u2069"],
    ["soft hyphen", "bo\u00ADb"],
    ["combining grapheme joiner", "bob\u034F"],
    ["variation selector on a letter", "bob\uFE0F"],
    ["tags outside a black flag", "bob\u{E0067}\u{E007F}"],
    ["hangul filler", "bob\u3164"],
    ["blank braille", "a\u2800"],
    ["Khitan small script filler", "bob\u{16FE4}"],
    ["musical null notehead", "bob\u{1D159}"],
    ["object replacement character", "bob\uFFFC"],
    ["no-break space", "ana\u00A0maria"],
    ["ideographic space", "ana\u3000maria"],
    ["em space", "ana\u2003maria"],
    ["narrow no-break space", "bob\u202F"],
    ["tab", "bo\tb"],
    ["newline", "bob\n"],
    ["line separator", "bob\u2028"],
    ["private use", "bob\uE000"],
    ["lone surrogate", "bob\uD800"],
    ["five combining marks in a row (Zalgo)", "bo\u0301\u0301\u0301\u0301\u0301b"],
    ["five stacking marks with spacing marks between (Zalgo)", "\u101C\u1036\u103B\u1036\u1031\u1036\u1036\u1036"],
    // Spacing marks are bounded too: never doubled, and at most eight marks of any kind on a letter
    ["five Devanagari visargas on a Latin letter", "bob\u0903\u0903\u0903\u0903\u0903"],
    ["six Burmese medial ya", "a\u103B\u103B\u103B\u103B\u103B\u103B"],
    ["five musical combining stems", "a\u{1D165}\u{1D165}\u{1D165}\u{1D165}\u{1D165}"],
    ["nine marks on a letter, none doubled", "\u101C\u103B\u1036\u103C\u1036\u1031\u1036\u102C\u1036\u1038"],
    ["mark on a trailing space", "bob \u0323"],
    ["two marks on a trailing space", "bob \u0323\u0301"],
    ["zero-width joiner between Latin letters", "an\u200Da"],
    ["zero-width non-joiner after a Persian word", "\u0645\u06CC\u200C"],
    ["zero-width joiner before a Sinhala word", "\u200D\u0DC1\u0DCA"],
    ["zero-width joiner between Sinhala and Latin", "\u0DC1\u0DCA\u200Da"],
    ["zero-width non-joiner between symbols", "<3\u200C<3"],
    ["starts with a combining mark", "\u0301bob"],
    ["starts with a spacing mark", "\u0903ab"],
    ["combining mark alone", "\u20DD"],
    ["Latin with a Greek nu", "Da\u03BDe"],
    ["Latin with a Greek upsilon", "Pa\u03C5l"],
    ["Latin with an Armenian oh", "b\u0585b"],
    ["Latin with a Cyrillic o", "b\u043Eb"],
    ["Latin with a Cherokee letter", "\u13A0ave"],
    ["Latin with a Lisu letter", "\uA4D3ave"],
    ["Latin with a Coptic o", "b\u2C9Fb"],
    ["Greek with Cyrillic", "\u03B1\u0431"],
    ["Cyrillic o with Armenian oh", "\u043E\u0585"],
    // Lowercase letters only listed in confusables.txt through their capital
    ["Latin with a Cyrillic small ka", "Mi\u043Ae"],
    ["Latin with a Cyrillic small ka at the end", "Jac\u043A"],
    ["Latin with a Cyrillic small em", "To\u043C"],
    ["Latin with a Greek small kappa", "Mi\u03BAe"],
    ["Latin with a Cherokee small lu", "To\uAB87"],
    // Accents don't hide the letter under them
    ["Latin with a Greek alpha with tonos", "D\u03ACve"],
    ["Latin with a Cyrillic yo", "Chlo\u0451"],
    ["Cyrillic I with Latin (refused as a mix, before any name comparison)", "\u0406VAN"],
    ["four Arabic ligatures (72 letters after NFKC)", "\uFDFA".repeat(4)],
    ["Latin with a Cyrillic o next to Han", "b\u043Eb \u674E"],
    ["symbol name with a zero-width space", "(\u2022_\u2022)\u200B"],
    ["blank braille between symbols", "<3\u2800<3"],
    // Spaces the app never sends: it trims the name and collapses its spaces (EXP-263, EXP-327)
    ["trailing space (iOS autocorrect)", "bob "],
    ["leading space", " bob"],
    ["two spaces in a row", "Ana  Mar\u00EDa"],
    ["two spaces between symbols", "<3  <3"],
    ["empty", ""],
    ["blank", "   "],
    ["too long (16 characters)", "a".repeat(16)],
  ])("refuses %s", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["bob"]])("refuses non-string %j", (value) => {
    expect(isValidUsername(value)).toBe(false);
  });
});

describe("looksLike", () => {
  it.each([
    ["math italic letters", "bob", "\u{1D44F}\u{1D45C}\u{1D44F}"],
    ["circled letters", "bob", "\u24D1\u24DE\u24D1"],
    ["full-width letters after a space", "ana maria", "ana \uFF4D\uFF41\uFF52\uFF49\uFF41"],
    ["case", "bob", "BoB"],
    ["full-width letters", "bob", "\uFF42\uFF4F\uFF42"],
    ["math bold letters", "bob", "\u{1D41B}\u{1D428}\u{1D41B}"],
    ["sharp s", "strasse", "Stra\u00DFe"],
    ["accents dropped", "Jose", "Jos\u00E9"],
    ["dot below dropped", "bob", "b\u1ECDb"],
    ["Cyrillic o", "bob", "b\u043Eb"],
    ["all-Cyrillic capitals", "BOB", "\u0412\u041E\u0412"],
    ["Cyrillic small ve as b", "bob", "\u0432\u043E\u0432"],
    ["Cyrillic izhitsa as v", "vera", "\u0475era"],
    ["Greek capitals", "KEN", "\u039A\u0395\u039D"],
    ["Greek nu as v (before folding)", "Dave", "Da\u03BDe"],
    ["Greek upsilon as u (before folding)", "Paul", "Pa\u03C5l"],
    ["Greek eta as n", "nina", "\u03B7i\u03B7a"],
    ["Armenian oh", "bob", "b\u0585b"],
    ["Latin small capitals", "Dave", "D\u1D00ve"],
    ["all small capitals", "dave", "\u1D05\u1D00\u1D20\u1D07"],
    ["Cherokee", "DAVE", "\u13A0\u13AA\u13D9\u13AC"],
    ["Lisu", "DAVE", "\uA4D3\uA4EE\uA4E6\uA4F0"],
    ["Coptic o", "bob", "b\u2C9Fb"],
    ["Latin iota", "ivan", "\u0269van"],
    ["capital I as l", "Alice", "AIice"],
    ["digit one as l", "lola", "1ola"],
    ["pipe as l", "lola", "|ola"],
    ["rn as m", "mike", "rnike"],
    ["vv as w", "will", "vvill"],
    ["cl as d", "dara", "clara"],
    ["zero as o", "bob", "b0b"],
    ["emoji presentation selector", "\u2764 ana", "\u2764\uFE0F ana"],
    ["kaomoji with full-width brackets", "(\u2022_\u2022)", "\uFF08\u2022_\u2022\uFF09"],
    ["shrug with full-width underscores", "\u00AF\\_(\u30C4)_/\u00AF", "\u00AF\\\uFF3F(\u30C4)\uFF3F/\u00AF"],
    ["hearts with a full-width less-than sign", "<3 <3", "\uFF1C3 <3"],
    ["full-width symbols", "<3 <3", "\uFF1C\uFF13 \uFF1C\uFF13"],
    ["emoji with a presentation selector", "\u{1F525}\u{1F525}", "\u{1F525}\uFE0F\u{1F525}"],
    // Lookalikes from any script or category (UTS #39 confusables with an ASCII prototype)
    ["Canadian Syllabics A", "Alice", "\u15C5lice"],
    ["box-drawing line as l", "Alice", "A\u2502ice"],
    ["APL alpha", "alice", "\u237Alice"],
    ["logical or as v", "Dave", "Da\u2228e"],
    ["union sign as U", "Paul", "Pa\u222Al"],
    ["estimated sign as e", "Dave", "Dav\u212E"],
    ["Georgian S", "Sam", "\u10BDam"],
    ["Tifinagh O", "Oscar", "\u2D54scar"],
    ["Runic I as l", "Ali", "A\u16C1i"],
    ["Hebrew samekh as o", "bob", "b\u05E1b"],
    ["Arabic alef as l", "Ali", "A\u0627i"],
    ["inverted exclamation mark as i", "Ivan", "\u00A1van"],
    ["long s as f (before NFKC turns it into s)", "Rafe", "Ra\u017Fe"],
    ["all-Cyrillic with small ka", "Mike", "\u041C\u0456\u043A\u0435"],
    ["all-Greek with small kappa and epsilon", "Mike", "\u039C\u03B9\u03BA\u03B5"],
    ["Cherokee small lu", "m", "\uAB87"],
    ["Telugu anusvara (a spacing mark) as o", "Bob", "B\u0C02b"],
    // Right-to-left letters are drawn reversed: compared in the order they are drawn too
    ["Hebrew samekh and vav drawn as lo", "Milo", "Mi\u05E1\u05D5"],
    ["Hebrew after Latin", "Carlo", "Car\u05E1\u05D5"],
    ["Hebrew and NKo run", "Pablo", "Pa\u05E1\u05D5\u07D5"],
    ["Arabic heh, non-joiner and alef", "Milo", "Mi\u0647\u200C\u0627"],
    // Arabic-Indic digits (bidi class AN) join the right-to-left run that follows them
    ["Arabic-Indic five and Hebrew vav", "Milo", "Mi\u0665\u05D5"],
    ["Arabic-Indic five and vav after Pab", "Pablo", "Pab\u0665\u05D5"],
    ["Arabic-Indic five and vav after Car", "Carlo", "Car\u0665\u05D5"],
    ["Arabic-Indic five with a shadda", "Milo", "Mi\u0665\u0651\u05D5"],
    ["Arabic-Indic seven and alef", "Lolv", "Lo\u0667\u0627"],
    ["right-to-left paragraph with a mirrored bracket", "loo)", "(\u05E1\u07CBl"],
    ["right-to-left paragraph with a decimal number", "1.2 o", "\u05E1 1.2"],
    ["Hebrew after math bold letters", "Milo", "\u{1D40C}\u{1D422}\u05E1\u05D5"],
    ["Hebrew with a holam on the vav", "Leo Lo", "Leo \u05E1\u05D5\u05B9"],
    ["Hebrew with a grave accent on the vav", "Mi lo", "Mi \u05E1\u05D5\u0300"],
    ["right-to-left paragraph drawn as M, heh, math zeros, Arabic-Indic five",
      "Moooo", "\u{1D7CE}\u{1D7CE}\u06F5\u0647M"],
  ])("%s \u2192 same name", (_label, a, b) => {
    expect(looksLike(a, b)).toBe(true);
  });

  it.each([
    ["bob", "rob"],
    ["ana", "ana2"],
    ["bob", "b ob"],
    ["Ivan", "Ian"],
    ["mike", "nike"],
    ["\u{1F469}\u200D\u{1F4BB} a", "\u{1F468}\u200D\u{1F4BB} a"],
    ["\u{1F525}\u{1F525}", "\u{1F525}"],
    ["(\u2022_\u2022)", "(-_-)"],
    ["<3", "</3"],
    ["!!", "!!!"],
    ["Rase", "Ra\u017Fe"],
    // A right-to-left name is never compared with its own reversal
    ["\u05D0\u05D1", "\u05D1\u05D0"],
    ["\u0623\u062D\u0645\u062F", "\u062F\u0645\u062D\u0623"],
    // NFKC turns spacing accents into a space plus a mark: the mark is kept, so they don't all read as blank
    ["\u00AF", "\u00B4"],
    ["\u00AF\\_(\u30C4)_/\u00AF", "\\_(\u30C4)_/"],
    ["( \u0361\u00B0 \u035C\u0296 \u0361\u00B0)", "( \u00B0 \u0296 \u00B0)"],
  ])("%j and %j stay distinct", (a, b) => {
    expect(looksLike(a, b)).toBe(false);
  });

  it.each([
    ["bob", "\uFF22ob"],
    ["bob", "b\u043Eb"],
    ["Alice", "A\u2502ice"],
    ["Milo", "Mi\u05E1\u05D5"],
  ])("%j and %j are the same name", (a, b) => {
    expect(sameName(a, b)).toBe(true);
  });

  // Real names that only meet in the visual key: refused as "too similar", not as the same name
  it.each([
    ["Clara", "Dara"],
    ["Erna", "Ema"],
    ["Arnie", "Amie"],
    ["Alice", "AIice"],
    ["bob", "b0b"],
    // Letters drawn like a capital I have the prototype "l" in UTS #39: they meet I only in the visual key
    ["I", "\u0406"],
    ["XI", "X\u0627"],
  ])("%j and %j look alike without being the same name", (a, b) => {
    expect(looksLike(a, b)).toBe(true);
    expect(sameName(a, b)).toBe(false);
  });

  it("keys are trimmed, case-folded Latin", () => {
    expect(nameKey("  B\u043E\u0412  ")).toBe("bob");
    expect(visualKey(" AIice ")).toBe("alice");
  });
});
