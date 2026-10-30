import { describe, expect, it } from "vitest";
import { isValidUsername, sameName } from "../managers/playerName";

// EXP-295, EXP-344: an Indic independent vowel carrying a dependent vowel sign, a virama (but the Bengali ya-phala) or
// a Latin-style diacritic draws like another vowel letter (Devanagari E + vowel sign E like the letter AI, Sinhala E +
// al-lakuna like EE, Devanagari E + breve like candra E), but the keys can't tell them apart, so the spelling is
// refused, as Unicode's "do not use" tables for these scripts ask. Real spellings put the signs on consonants.
// Every non-ASCII character is written as an escape on purpose.

describe("Indic independent vowels with a vowel sign", () => {
  it.each([
    ["Devanagari E + sign E (like AI)", "\u090F\u0947"],
    ["Devanagari A + sign AA (like AA)", "\u0905\u093E"],
    ["Devanagari A + sign candra E (like candra A)", "\u0905\u0945"],
    ["Bengali A + sign AA (like AA)", "\u0985\u09BE"],
    ["Gurmukhi A + sign AI (like AI)", "\u0A05\u0A48"],
    ["Gujarati A + sign E (like E)", "\u0A85\u0AC7"],
    ["Oriya A + sign AA (like AA)", "\u0B05\u0B3E"],
    ["Telugu O + sign AU (like AU)", "\u0C12\u0C4C"],
    ["Kannada vocalic L + sign AA (like vocalic LL)", "\u0C8C\u0CBE"],
    ["Malayalam O + sign AA (like OO)", "\u0D12\u0D3E"],
    ["Sinhala E + sign kombuva (like AI)", "\u0D91\u0DD9"],
    ["Gurmukhi A + Devanagari sign AI (like the Gurmukhi AI)", "\u0A05\u0948"],
    ["Devanagari E + nukta + sign E", "\u090F\u093C\u0947"],
    // Gurmukhi vowel bearers iri and ura
    ["Gurmukhi iri + sign I (like I)", "\u0A72\u0A3F"],
    ["Gurmukhi ura + sign U (like U)", "\u0A73\u0A41"],
    ["Gurmukhi ura + sign O (like O)", "\u0A73\u0A4B"],
    // Latin-style diacritics (EXP-344)
    ["Devanagari E + combining breve (like candra E)", "\u090F\u0306"],
    ["Devanagari A + combining breve (like candra A)", "\u0905\u0306"],
    ["Devanagari E + anusvara + combining breve", "\u090F\u0902\u0306"],
    ["Bengali A + combining dot below", "\u0985\u0323"],
    ["Tamil A + combining long solidus overlay", "\u0B85\u0338"],
  ])("%s is refused, alone or in a name", (_label, spelling) => {
    expect(isValidUsername(spelling)).toBe(false);
    expect(isValidUsername(`\u0930\u093E${spelling}\u0928`)).toBe(false);
  });

  it.each([
    ["Sinhala E + al-lakuna (like EE)", "\u0D91\u0DCA"],
    ["Devanagari A + virama", "\u0905\u094D"],
    ["Bengali E + virama", "\u098F\u09CD"],
    ["Malayalam A + vertical bar virama", "\u0D05\u0D3B"],
  ])("%s, a virama on a vowel, is refused at the end, before a space or before a consonant", (_label, spelling) => {
    expect(isValidUsername(spelling)).toBe(false);
    expect(isValidUsername(`\u0930\u093E${spelling}`)).toBe(false);
    expect(isValidUsername(`${spelling} \u0928`)).toBe(false);
  });

  it.each([
    ["Sinhala E + al-lakuna + ma (like EE + ma)", "\u0D91\u0DCA\u0DB8"],
    ["Sinhala O + al-lakuna + ma (like OO + ma)", "\u0D94\u0DCA\u0DB8"],
    ["Sinhala O + al-lakuna + ka (like OO + ka)", "\u0D94\u0DCA\u0D9A"],
    ["Sinhala E + al-lakuna + kanayaka (like Ekanayaka)", "\u0D91\u0DCA\u0D9A\u0DB1\u0DCF\u0DBA\u0D9A"],
    ["Devanagari A + virama + ka", "\u0905\u094D\u0915"],
    ["Bengali A + virama + ka (only ya makes a ya-phala)", "\u0985\u09CD\u0995"],
    ["Bengali I + virama + ya (the ya-phala only goes on A and E)", "\u0987\u09CD\u09AF"],
  ])("%s is refused, alone or in a name", (_label, spelling) => {
    expect(isValidUsername(spelling)).toBe(false);
    expect(isValidUsername(`\u0DB8\u0DC4\u0DBA${spelling}`)).toBe(false);
  });

  it.each([
    ["Aishwarya (AI letter)", "\u0910\u0936\u094D\u0935\u0930\u094D\u092F\u093E"],
    ["Aditya (AA letter)", "\u0906\u0926\u093F\u0924\u094D\u092F"],
    ["ke (sign on a consonant)", "\u0915\u0947"],
    ["am (anusvara on a vowel)", "\u0905\u0902"],
    ["Marathi Anna with candra A", "\u0972\u0928\u093E"],
    ["Bengali Alex (A + virama + ya + sign AA)", "\u0985\u09CD\u09AF\u09BE\u09B2\u09C7\u0995\u09CD\u09B8"],
    ["Bengali Alex with a joiner after the virama", "\u0985\u09CD\u200D\u09AF\u09BE\u09B2\u09C7\u0995\u09CD\u09B8"],
    ["Bengali Andrew (E + virama + ya)", "\u098F\u09CD\u09AF\u09BE\u09A8\u09CD\u09A1\u09CD\u09B0\u09C1"],
    ["Gurmukhi Iqbal (I letter)", "\u0A07\u0A15\u0A2C\u0A3E\u0A32"],
    ["Gurmukhi Amrit (tippi on A)", "\u0A05\u0A70\u0A2E\u0A4D\u0A30\u0A3F\u0A24"],
    ["Tamil Auvai", "\u0B94\u0BB5\u0BC8"],
    ["Malayalam Ouseppu", "\u0D14\u0D38\u0D47\u0D2A\u0D4D\u0D2A\u0D4D"],
    ["Sinhala Ama", "\u0D85\u0DB8\u0DCF"],
  ])("%s stays valid", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it("accepts the Tamil AU letter typed as O + AU length mark, which NFC composes into it", () => {
    const decomposed = "\u0B92\u0BD7\u0BB5\u0BC8";
    expect(isValidUsername(decomposed)).toBe(true);
    expect(sameName(decomposed, "\u0B94\u0BB5\u0BC8")).toBe(true);
  });
});
