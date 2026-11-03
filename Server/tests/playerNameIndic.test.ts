import { describe, expect, it } from "vitest";
import { isValidUsername, nameClash, nameKeys, sameName } from "../managers/playerName";

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

// EXP-343: the keys keep the dependent vowel signs, so names that differ by a vowel sign are different names ("Raj" and
// "Raju"), while the other marks are still dropped (nukta, anusvara, candrabindu; the virama is kept since EXP-374). A
// sign alone on a letter of its script is the only spelling accepted, so no stack of signs or foreign mark draws like a
// sign the keys don't see.

const clash = (a: string, b: string) => nameClash(nameKeys(a), nameKeys(b));

describe("Indic dependent vowel signs (EXP-343)", () => {
  it.each([
    ["Devanagari Raj / Raju", "\u0930\u093E\u091C", "\u0930\u093E\u091C\u0941"],
    ["Devanagari Raju / Raje", "\u0930\u093E\u091C\u0941", "\u0930\u093E\u091C\u0947"],
    ["Devanagari Raju / Rajoo", "\u0930\u093E\u091C\u0941", "\u0930\u093E\u091C\u0942"],
    ["Devanagari Kesh / Kaish (E and AI signs)", "\u0915\u0947\u0936", "\u0915\u0948\u0936"],
    ["Marathi Sam with candra E / Sam", "\u0938\u0945\u092E", "\u0938\u092E"],
    ["Bengali Raju / Raj", "\u09B0\u09BE\u099C\u09C1", "\u09B0\u09BE\u099C"],
    ["Gurmukhi Raju / Raj", "\u0A30\u0A3E\u0A1C\u0A42", "\u0A30\u0A3E\u0A1C"],
    ["Gurmukhi Kesh / Kosh (EE and OO signs)", "\u0A15\u0A47\u0A38\u0A3C", "\u0A15\u0A4B\u0A38\u0A3C"],
    ["Gujarati Raju / Raj", "\u0AB0\u0ABE\u0A9C\u0AC1", "\u0AB0\u0ABE\u0A9C"],
    ["Oriya Kiran / Karan", "\u0B15\u0B3F\u0B30\u0B23", "\u0B15\u0B30\u0B23"],
    ["Tamil Geetha / Gatha", "\u0B95\u0BC0\u0BA4\u0BBE", "\u0B95\u0BA4\u0BBE"],
    ["Telugu Seeta / Sata", "\u0C38\u0C40\u0C24", "\u0C38\u0C24"],
    ["Kannada Kiran / Karan", "\u0C95\u0CBF\u0CB0\u0CA3", "\u0C95\u0CB0\u0CA3"],
    ["Malayalam Raju / Raj", "\u0D30\u0D3E\u0D1C\u0D41", "\u0D30\u0D3E\u0D1C"],
    ["Sinhala Nimal / Namal", "\u0DB1\u0DD2\u0DB8\u0DBD\u0DCA", "\u0DB1\u0DB8\u0DBD\u0DCA"],
  ])("%s are different names", (_label, a, b) => {
    expect(isValidUsername(a)).toBe(true);
    expect(isValidUsername(b)).toBe(true);
    expect(clash(a, b)).toBeNull();
  });

  it.each([
    ["nukta", "\u0930\u093E\u091C", "\u0930\u093E\u091C\u093C"],
    ["anusvara", "\u0930\u093E\u091C", "\u0930\u093E\u091C\u0902"],
    ["candrabindu", "\u092E\u093E", "\u092E\u093E\u0901"],
    ["Gurmukhi tippi", "\u0A15\u0A3E", "\u0A15\u0A3E\u0A70"],
    // Drawn blank by Kohinoor Devanagari on iOS
    ["Devanagari sign OE", "\u0930\u093E\u091C", "\u0930\u093E\u091C\u093A"],
    // NFC joins the two parts
    ["Bengali O typed in two parts", "\u0995\u09CB", "\u0995\u09C7\u09BE"],
  ])("a %s still doesn't make another name", (_label, a, b) => {
    expect(isValidUsername(b)).toBe(true);
    expect(clash(a, b)).toBe("same");
  });

  it.each([
    // Differ by a dot
    ["Devanagari candrabindu and candra E", "\u0938\u0901\u092E", "\u0938\u0945\u092E"],
    ["Gujarati candrabindu and candra E", "\u0AB8\u0A81\u0AAE", "\u0AB8\u0AC5\u0AAE"],
    // Measured alike in Kohinoor (iOS) and Noto Sans (Android)
    ["Devanagari short E and E", "\u0915\u0946\u0936\u0935", "\u0915\u0947\u0936\u0935"],
    // The long vocalic signs, only spelled in Sanskrit, draw as the short ones with one more curl
    ["Devanagari Krishna with vocalic R and RR", "\u0915\u0943\u0937\u094D\u0923", "\u0915\u0944\u0937\u094D\u0923"],
    ["Oriya vocalic L and LL", "\u0B15\u0B62", "\u0B15\u0B63"],
    ["Kannada vocalic L and LL", "\u0C95\u0CE2", "\u0C95\u0CE3"],
    // Drawn alike by UTS #39
    ["Malayalam U and UU", "\u0D30\u0D3E\u0D1C\u0D41", "\u0D30\u0D3E\u0D1C\u0D42"],
    ["Malayalam U and vocalic R", "\u0D30\u0D3E\u0D1C\u0D41", "\u0D30\u0D3E\u0D1C\u0D43"],
    // Devanagari spells the short vowels of Dravidian names with signs drawn almost like the long ones
    ["Devanagari short O and O", "\u0915\u094A\u0932", "\u0915\u094B\u0932"],
    // The overline is drawn over the letter like the hook of sign I
    ["Oriya sign I and overline", "\u0B15\u0B3F", "\u0B15\u0B55"],
  ])("%s look too alike", (_label, a, b) => {
    expect(isValidUsername(a)).toBe(true);
    expect(isValidUsername(b)).toBe(true);
    expect(clash(a, b)).toBe("similar");
  });

  it.each([
    // Two signs on a letter
    ["two E signs", "\u0930\u093E\u091C\u0947\u0947"],
    ["U + E (draws like E + U)", "\u0930\u093E\u091C\u0941\u0947"],
    ["AA + E (draws like O)", "\u0915\u093E\u0947"],
    ["Sinhala two kombuvas (like kombu deka)", "\u0D9A\u0DD9\u0DD9"],
    ["Telugu E + length mark (like EE)", "\u0C15\u0C46\u0C55"],
    // A length mark alone: NFC joins it with the first half of its two-part vowel, so alone it is a vowel cut in half
    ["Kannada Deva with the EE length mark alone (like Deva)", "\u0CA6\u0CD5\u0CB5"],
    ["Kannada AI length mark alone (like AI)", "\u0C95\u0CD6"],
    ["Telugu length mark alone", "\u0C15\u0C55"],
    ["Telugu AI length mark alone (like AI)", "\u0C15\u0C56"],
    ["Oriya AI length mark alone (like AI)", "\u0B15\u0B56"],
    ["Tamil AU length mark alone (drawn like the letter LLA)", "\u0B95\u0BD7"],
    ["Bengali AU length mark alone (like AU)", "\u0995\u09D7"],
    ["Oriya AU length mark alone (like AU)", "\u0B15\u0B57"],
    // A sign anywhere but on a letter of its script
    ["Gujarati U on a Devanagari letter (like Raju)", "\u0930\u093E\u091C\u0AC1"],
    ["Devanagari AI on a Gurmukhi letter", "\u0A15\u0948"],
    ["Devanagari E on a Latin letter", "ba\u0947b"],
    ["Devanagari U on a Devanagari digit", "\u0930\u093E\u0967\u0941"],
    ["Devanagari U on a space", "\u0930\u093E \u0941\u091C"],
    ["Devanagari U after a non-joiner", "\u0930\u093E\u091C\u200C\u0941"],
    // A mark of another script on an Indic letter
    ["combining breve (like candra E)", "\u0938\u0306\u092E"],
    ["combining grave accent", "\u0930\u093E\u091C\u0300"],
    ["Devanagari grave accent (like the E sign)", "\u0930\u093E\u091C\u0953"],
    ["Devanagari udatta", "\u0930\u093E\u091C\u0951"],
    ["Gurmukhi U on a Devanagari letter", "\u0930\u093E\u091C\u0A41"],
    ["Thai sara i on a Devanagari letter", "\u0930\u093E\u091C\u0E34"],
  ])("%s is refused", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it.each([
    ["Raju", "\u0930\u093E\u091C\u0941"],
    ["Kshitij (conjunct, sign I)", "\u0915\u094D\u0937\u093F\u0924\u093F\u091C"],
    ["Zeenat (nukta + sign II)", "\u091C\u093C\u0940\u0928\u0924"],
    ["Maa with candrabindu", "\u092E\u093E\u0901"],
    ["Bengali Kakoli (two-part O)", "\u0995\u09BE\u0995\u09CB\u09B2\u09BF"],
    ["Tamil Shri (virama, sign II)", "\u0BB6\u0BCD\u0BB0\u0BC0"],
    ["Sinhala Sri with a joiner", "\u0DC1\u0DCA\u200D\u0DBB\u0DD3"],
    ["Malayalam Ouseppu", "\u0D14\u0D38\u0D47\u0D2A\u0D4D\u0D2A\u0D4D"],
    // Modern Malayalam writes AU with the length mark alone
    ["Malayalam Kau with the AU length mark alone", "\u0D15\u0D57"],
  ])("%s stays valid", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    ["Kannada Deva (E + length mark is EE)", "\u0CA6\u0CC6\u0CD5\u0CB5", "\u0CA6\u0CC7\u0CB5"],
    ["Kannada Kai (E + AI length mark)", "\u0C95\u0CC6\u0CD6", "\u0C95\u0CC8"],
    ["Kannada Kee (I + length mark is II)", "\u0C95\u0CBF\u0CD5", "\u0C95\u0CC0"],
    ["Telugu Kai (E + AI length mark)", "\u0C15\u0C46\u0C56", "\u0C15\u0C48"],
    ["Oriya Kai (E + AI length mark)", "\u0B15\u0B47\u0B56", "\u0B15\u0B48"],
    ["Tamil Kau (E + AU length mark)", "\u0B95\u0BC6\u0BD7", "\u0B95\u0BCC"],
    ["Bengali Kau (E + AU length mark)", "\u0995\u09C7\u09D7", "\u0995\u09CC"],
    ["Oriya Kau (E + AU length mark)", "\u0B15\u0B47\u0B57", "\u0B15\u0B4C"],
  ])("%s typed in two parts is valid and the same name as the one sign NFC makes", (_label, twoParts, oneSign) => {
    expect(isValidUsername(twoParts)).toBe(true);
    expect(clash(twoParts, oneSign)).toBe("same");
  });
});
