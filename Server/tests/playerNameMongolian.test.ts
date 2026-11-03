import { describe, expect, it } from "vitest";
import { isValidUsername, nameClash, nameKeys } from "../managers/playerName";

// EXP-376: the Unicode Standard (chapter 13.2, Mongolian) encodes O and U, and OE and UE, apart for their sound, though
// "o is written identically to u in all positional forms, ö is written identically to ü in all positional forms".
// Every non-ASCII character is written as an escape, as the letters only differ by code point.

const clash = (a: string, b: string) => nameClash(nameKeys(a), nameKeys(b));

const BA = "\u182A";
const LA = "\u182F";
const TA = "\u1832";
const DA = "\u1833";
const RA = "\u1837";
const QA = "\u182C";
const GA = "\u182D";
const A = "\u1820";
const O = "\u1823";
const U = "\u1824";
const OE = "\u1825";
const UE = "\u1826";
const EE = "\u1827";
const I = "\u1822";
const YA = "\u1836";
const TSA = "\u183C";
const HA = "\u183E";
const ZRA = "\u183F";
const LHA = "\u1840";
const ZHA = "\u1841";

const expectSimilar = (a: string, b: string) => {
  expect(isValidUsername(a)).toBe(true);
  expect(isValidUsername(b)).toBe(true);
  expect(clash(a, b)).toBe("similar");
};

const expectDistinct = (a: string, b: string) => {
  expect(isValidUsername(a)).toBe(true);
  expect(isValidUsername(b)).toBe(true);
  expect(clash(a, b)).toBeNull();
};

describe("Mongolian vowels written alike (EXP-376)", () => {
  it.each([
    ["O / U alone", O, U],
    ["O / U first", `${O}${LA}`, `${U}${LA}`],
    ["O / U in the middle (bol / bul)", `${BA}${O}${LA}`, `${BA}${U}${LA}`],
    ["O / U last", `${BA}${O}`, `${BA}${U}`],
    ["OE / UE in the middle", `${BA}${OE}${LA}`, `${BA}${UE}${LA}`],
    ["OE / UE in two syllables", `${TA}${OE}${LA}${OE}`, `${TA}${UE}${LA}${UE}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  // Drawn apart in a word's first syllable, where OE and UE carry one more stroke
  it("keeps O and OE apart", () => {
    expect(clash(`${BA}${O}${LA}`, `${BA}${OE}${LA}`)).toBeNull();
    expect(clash(`${BA}${U}${LA}`, `${BA}${UE}${LA}`)).toBeNull();
  });
});

// EXP-385: letters the Unicode Standard (chapter 13.2) writes alike only in some places of a word: OE and UE like O and
// U past the first syllable ("tolö" like "tolo"), and D like T inside a word before a vowel ("urtu" and "ordu"). Each
// pair checked with HarfBuzz on Noto Sans Mongolian 3.002, the font of iOS, and 1.04, the font of Android: drawn alike
// in one of them, or apart in both.
describe("Mongolian letters drawn alike by their place in the word (EXP-385)", () => {
  it.each([
    ["tolo / toloe (OE last)", `${TA}${O}${LA}${O}`, `${TA}${O}${LA}${OE}`],
    ["bolu / bolue (UE last)", `${BA}${O}${LA}${U}`, `${BA}${O}${LA}${UE}`],
    ["OE right after O", `${BA}${O}${OE}`, `${BA}${O}${O}`],
    ["OE after two syllables", `${BA}${O}${LA}${O}${OE}`, `${BA}${O}${LA}${O}${O}`],
    ["urtu / ordu", `${U}${RA}${TA}${U}`, `${O}${RA}${DA}${U}`],
    ["bada / bata", `${BA}${A}${DA}${A}`, `${BA}${A}${TA}${A}`],
    ["D before OE / T before O", `${BA}${A}${DA}${OE}`, `${BA}${A}${TA}${O}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    // OE and UE carry one more stroke in the first syllable
    ["OE in the first syllable", `${BA}${O}${LA}`, `${BA}${OE}${LA}`],
    // Q and G take another shape next to OE
    ["OE past the first syllable before GA", `${BA}${OE}${LA}${OE}${GA}`, `${BA}${OE}${LA}${O}${GA}`],
    // D and T keep their shapes alone, last in a word and inside it before a consonant
    ["D / T alone", DA, TA],
    ["D / T last", `${BA}${A}${DA}`, `${BA}${A}${TA}`],
    ["D / T before a consonant", `${BA}${A}${DA}${LA}`, `${BA}${A}${TA}${LA}`],
  ])("%s are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  // Punctuation and digits join nothing, so a word next to them is still read (MONGOLIAN_SHAPING)
  it.each([
    ["the Manchu full stop", `${TA}${O}${LA}${OE}\u1809`, `${TA}${O}${LA}${O}:`],
    ["the full stop", `${TA}${O}${LA}${O}\u1803`, `${TA}${O}${LA}${OE}\u1803`],
    ["a digit after", `${TA}${O}${LA}${O}\u1811`, `${TA}${O}${LA}${OE}\u1811`],
    ["a digit before", `\u1811${TA}${O}${LA}${O}`, `\u1811${TA}${O}${LA}${OE}`],
  ])("reads a word next to %s", (_label, a, b) => {
    expectSimilar(a, b);
  });

  // A letter joined to the word changes its shapes: Sibe UE after it draws OE apart from O
  it("leaves out a word another letter joins", () => {
    expect(clash(`${TA}${O}${LA}${O}\u1860`, `${TA}${O}${LA}${OE}\u1860`)).toBeNull();
  });

  // The positional reading is one more reading of the name (similarKeys): a word it leaves out in one name and reads in
  // the other (a mark or a Manchu full stop next to it) still meets it as typed
  it.each([
    ["Manchu full stop / full stop", "\u1832\u1820\u1826\u1832\u1809", "\u1832\u1820\u1826\u1832\u1803"],
    ["Manchu full stop / colon", "\u1832\u1824\u182F\u1825\u1809", "\u1832\u1823\u182F\u1825:"],
    ["baluda after the word / none", "\u1832\u1824\u182F\u1825\u1885", "\u1832\u1823\u182F\u1825"],
    ["none / baluda inside the word", "\u1822\u1826\u1833\u1821", "\u1822\u1825\u1833\u1885\u1821"],
    ["Ali Gali dagalga inside the word / none", "\u1825:\u1820\u18A9\u1825", "\u1825:\u1820\u1826"],
  ])("%s still look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  // EXP-407: Noto Sans Mongolian 3.002 (iOS) draws the words "ᠤᠤ" and "ᠦᠦ" on their own, but 1.04, the font Android
  // ships, draws them like these (HarfBuzz), so a name in one room may still not take the other
  it.each([
    ["U U / O U", `${U}${U}`, `${O}${U}`],
    ["U U / U O", `${U}${U}`, `${U}${O}`],
    ["U U / O O", `${U}${U}`, `${O}${O}`],
    ["U U / U OE", `${U}${U}`, `${U}${OE}`],
    ["UE UE / OE UE", `${UE}${UE}`, `${OE}${UE}`],
    ["UE UE / UE OE", `${UE}${UE}`, `${UE}${OE}`],
    ["UE UE / OE OE", `${UE}${UE}`, `${OE}${OE}`],
    ["UE UE / UE U", `${UE}${UE}`, `${UE}${U}`],
    ["U U before another word", `${U}${U} ${BA}${A}`, `${O}${U} ${BA}${A}`],
  ])("keeps the word %s, drawn alike on Android, too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it("reads each word on its own", () => {
    expectSimilar(`${TA}${O}${LA}${O} ${TA}${O}`, `${TA}${O}${LA}${OE} ${TA}${O}`);
    // A word's first syllable stays one after another word
    expectDistinct(`${TA}${O}${LA} ${TA}${O}${LA}`, `${TA}${O}${LA} ${TA}${OE}${LA}`);
  });
});

// EXP-409: Noto Sans Mongolian 3.002 (iOS) draws the words "ᠤᠤ" and "ᠦᠦ" alike (O + U), and apart from "ᠣᠣ" and "ᠥᠥ",
// as 1.04 (Android) does with "ᠦᠦ" and "ᠣᠣ", and "ᠤᠤ" and "ᠥᠥ"
describe("Mongolian words U U and UE UE, drawn alike on iOS (EXP-409)", () => {
  it.each([
    ["on their own", `${U}${U}`, `${UE}${UE}`],
    ["before another word", `${U}${U} ${BA}`, `${UE}${UE} ${BA}`],
    ["next to a word read by its place", `${U}${U} ${TA}${O}${LA}${OE}`, `${UE}${UE} ${TA}${O}${LA}${O}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["UE UE / O O", `${UE}${UE}`, `${O}${O}`],
    ["U U / OE OE", `${U}${U}`, `${OE}${OE}`],
    ["inside a longer word", `${U}${U}${LA}`, `${UE}${UE}${LA}`],
    // Alike on iOS but for "ᠲᠥ", which only Android draws like "ᠲᠣ": readings of two fonts never meet
    ["with a word only Android draws alike", `${U}${U} ${TA}${OE}`, `${UE}${UE} ${TA}${O}`],
  ])("%s are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-410: Noto Sans Mongolian 1.04 (Android) draws OE and UE like O and U in more places than 3.002 (iOS), D like T in
// more places, and U like OE after B inside a word. Each pair checked with HarfBuzz on both fonts
describe("Mongolian letters drawn alike by Android's font (EXP-410)", () => {
  it.each([
    ["OE ending a word of two letters", `${TA}${O}`, `${TA}${OE}`],
    ["OE after two consonants", `${TA}${LA}${OE}${LA}`, `${TA}${LA}${O}${LA}`],
    ["D / T first before a vowel", `${DA}${A}`, `${TA}${A}`],
    // So iOS draws them too
    ["D / T first before a consonant", `${DA}${LA}`, `${TA}${LA}`],
    ["D / T before EE", `${BA}${A}${DA}${EE}`, `${BA}${A}${TA}${EE}`],
    ["U / OE after B inside a word", `${LA}${BA}${U}${LA}`, `${LA}${BA}${OE}${LA}`],
    ["OE before a G that takes the next vowel's shape", `${LA}${O}${LA}${OE}${LA}${GA}${A}`,
      `${LA}${O}${LA}${O}${LA}${GA}${A}`],
    ["OE after a G that takes an earlier vowel's shape", `${A}${GA}${LA}${OE}`, `${A}${GA}${LA}${O}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["O / OE after B inside a word", `${LA}${BA}${O}${LA}`, `${LA}${BA}${OE}${LA}`],
    ["OE right after Q", `${QA}${OE}`, `${QA}${O}`],
    ["OE right after G", `${LA}${GA}${OE}`, `${LA}${GA}${O}`],
    // A G before a consonant, I or the word's end takes the shape of the nearest vowel but I before it, or after it
    ["OE before I and a G ending the word", `${LA}${O}${LA}${OE}${LA}${I}${GA}`, `${LA}${O}${LA}${O}${LA}${I}${GA}`],
    ["OE after a G that starts the word", `${GA}${LA}${OE}${LA}`, `${GA}${LA}${O}${LA}`],
    ["OE after I and a G", `${I}${GA}${LA}${OE}`, `${I}${GA}${LA}${O}`],
    // Alike on Android but for U after B, which only iOS draws like O: readings of two fonts never meet
    ["with a word only iOS draws alike", `${LA}${BA}${U}${LA} ${TA}${OE}`, `${LA}${BA}${O}${LA} ${TA}${O}`],
  ])("%s are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-414: Q and G take the gender of the vowel they look at, so only that vowel keeps its gender; the other vowels of
// the word are read as each font draws them. Each pair checked with HarfBuzz on both fonts
describe("Mongolian vowels in words with Q or G (EXP-414)", () => {
  it.each([
    ["OE before a G and an I ending the word", `${LA}${O}${LA}${OE}${GA}${I}`, `${LA}${O}${LA}${O}${GA}${I}`],
    ["OE after a G and an I", `${ZHA}${GA}${I}${OE}`, `${ZHA}${GA}${I}${O}`],
    ["OE after a G that takes an earlier vowel's gender", `${TSA}${U}${DA}${GA}${RA}${O}${TSA}${EE}`,
      `${TSA}${U}${DA}${GA}${RA}${OE}${TSA}${EE}`],
    ["O / UE before a G two letters on", `${GA}${I}${O}${HA}${GA}${TA}`, `${GA}${I}${UE}${HA}${GA}${TA}`],
    ["OE before a G that an I follows", `${UE}${OE}${GA}${I}${U}${UE}${I}`, `${UE}${O}${GA}${I}${U}${UE}${I}`],
    // Android: a G looks ahead past one consonant only
    ["OE two consonants after a G", `${TA}${GA}${DA}${LHA}${OE}${A}`, `${TA}${GA}${DA}${LHA}${O}${A}`],
    // iOS: a G ending the word only looks at a vowel right before it, or before an I
    ["OE two letters before a G ending the word", `${A}${LA}${OE}${LA}${GA}`, `${A}${LA}${O}${LA}${GA}`],
    // iOS: only a G right after an I looks ahead, past consonants and I
    ["OE after a G no I comes before", `${LA}${GA}${LA}${I}${OE}`, `${LA}${GA}${LA}${I}${O}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    // iOS: a G ending the word after an I looks back past consonants and I; Android: past consonants and one I
    ["OE before D, I and a G ending the word", `${A}${LA}${OE}${DA}${I}${GA}`, `${A}${LA}${O}${DA}${I}${GA}`],
  ])("%s are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  // iOS draws these like the font of Android too, so a name with a word only iOS draws alike still meets
  it.each([
    ["D first before a consonant", `${TA}${LA}${A} ${A}${LA}${OE}${LA}${GA}`, `${DA}${LA}${A} ${A}${LA}${O}${LA}${GA}`],
    ["OE ending a word after two consonants", `${DA}${ZRA}${OE} ${A}${LA}${OE}${LA}${GA}`,
      `${DA}${ZRA}${O} ${A}${LA}${O}${LA}${GA}`],
  ])("reads %s as iOS draws it", (_label, a, b) => {
    expectSimilar(a, b);
  });
});

// EXP-415: each font's reading reads alike only what that font draws alike, so a name of two words, one drawn alike
// only on iOS and the other only on Android, is drawn apart on every phone
describe("Mongolian names of several words drawn alike by no font (EXP-415)", () => {
  it.each([
    // "ᠤᠤ" like "ᠣᠣ" on Android, U after B like O on iOS
    ["U U / O O and U / O after B", `${O}${O} ${LA}${BA}${O}${LA}`, `${U}${U} ${LA}${BA}${U}${LA}`],
    // "ᠬᠦ" apart from "ᠬᠥ" on Android
    ["Q UE / Q OE", `${QA}${UE} ${TA}${OE}`, `${QA}${OE} ${TA}${O}`],
    // "ᠪᠦᠦ" apart from "ᠪᠥᠦ" on iOS
    ["B UE UE / B OE UE", `${BA}${UE}${UE} ${QA}${UE}`, `${BA}${OE}${UE} ${QA}${OE}`],
    // U after B by a G apart from O on Android
    ["U / O after B by a G", `${GA}${BA}${U}${UE}${YA} ${TA}${OE}`, `${GA}${BA}${O}${UE}${YA} ${TA}${O}`],
  ])("%s with a word only the other font draws alike are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  // A run a mark, an Ali Gali sign or a virama touches is no word, so no font reading reads it: there U and UE read as
  // O and OE as Unicode writes them, as one font draws them
  it.each([
    ["an Ali Gali sign after", `${LA}${BA}${O}${LA}\u1885`, `${LA}${BA}${U}${LA}\u1885`],
    ["a Gurmukhi udaat before", `\u0A1C\u0A51${LA}${BA}${O}${LA}`, `\u0A1C\u0A51${LA}${BA}${U}${LA}`],
    ["a Bengali virama before Q OE / Q UE", `\u09A4\u09CD${QA}${OE}`, `\u09A4\u09CD${QA}${UE}`],
    ["a Bengali virama before U U / O U", `\u09A4\u09CD${U}${U}`, `\u09A4\u09CD${O}${U}`],
  ])("%s: U and UE read as O and OE", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["B UE UE / B U U, alike on iOS", `${BA}${UE}${UE}`, `${BA}${U}${U}`],
    ["two words alike on iOS", `${BA}${UE}${UE} ${U}${U}`, `${BA}${U}${U} ${UE}${UE}`],
    ["two words alike on Android", `${BA}${UE}${UE} ${TA}${OE}`, `${BA}${OE}${UE} ${TA}${O}`],
    ["U / O after B by a G, alike on iOS", `${GA}${BA}${U}${UE}${YA}`, `${GA}${BA}${O}${UE}${YA}`],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });
});
