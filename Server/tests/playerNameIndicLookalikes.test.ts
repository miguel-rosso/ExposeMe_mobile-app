import { describe, expect, it } from "vitest";
import {
  INDIC_LOOKALIKES, isValidUsername, letterVisualKey, nameClash, nameKeys, visualKey,
} from "../managers/playerName";

// Indic letters drawn like a letter and a vowel sign (EXP-356), the Sinhala long vowels the keys lost (EXP-357), the
// candra O next to a candrabindu and rare marks that hide a vowel sign (EXP-362). Every non-ASCII character is written
// as an escape on purpose, so an editor's NFC can't merge the spellings typed in two parts.

const clash = (a: string, b: string) => nameClash(nameKeys(a), nameKeys(b));

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

// EXP-356: UTS #39 draws these letters, digits and signs like a letter of their script plus a vowel sign, or like
// another letter; now that the keys keep vowel signs (EXP-343), the visual keys read them so.
describe("Indic characters drawn like a letter and a vowel sign (EXP-356)", () => {
  it.each([
    ["Telugu Hari / Vaari (HA like VA + AA)", "\u0C39\u0C30\u0C3F", "\u0C35\u0C3E\u0C30\u0C3F"],
    ["Telugu Mani / Vuni (MA like VA + U)", "\u0C2E\u0C28\u0C3F", "\u0C35\u0C41\u0C28\u0C3F"],
    ["Malayalam NGA / NA + U", "\u0D15\u0D19", "\u0D15\u0D28\u0D41"],
    ["Malayalam vocalic L / NA + U", "\u0D0C", "\u0D28\u0D41"],
    ["Malayalam date mark / NA + U", "\u0D2E\u0D79", "\u0D2E\u0D28\u0D41"],
    ["Sinhala IRUYANNA / SA + GAETTA-PILLA", "\u0D8D", "\u0DC3\u0DD8"],
    ["Tamil Khan / Karan (sign AA like RA)", "\u0B95\u0BBE\u0BA9\u0BCD", "\u0B95\u0BB0\u0BA9\u0BCD"],
    ["Tamil sign AA / letter II", "\u0B95\u0BBE", "\u0B95\u0B88"],
    ["Tamil Gowri / KA + E + LLA (AU sign like E + LLA)", "\u0B95\u0BCC\u0BB0\u0BBF", "\u0B95\u0BC6\u0BB3\u0BB0\u0BBF"],
    ["Tamil Auvai / O + LLA (letter AU like O + LLA)", "\u0B94\u0BB5\u0BC8", "\u0B92\u0BB3\u0BB5\u0BC8"],
    ["Gowri in two parts / KA + E + LLA", "\u0B95\u0BC6\u0BD7\u0BB0\u0BBF", "\u0B95\u0BC6\u0BB3\u0BB0\u0BBF"],
    ["Tamil Kodi / KA + E + RA (O sign like E + AA)", "\u0B95\u0BCA\u0B9F\u0BBF", "\u0B95\u0BC6\u0BB0\u0B9F\u0BBF"],
    ["Tamil Koo / KA + EE + RA (OO sign like EE + AA)", "\u0B95\u0BCB", "\u0B95\u0BC7\u0BB0"],
    ["Tamil Guru / GU + digit five", "\u0B95\u0BC1\u0BB0\u0BC1", "\u0B95\u0BC1\u0BEB"],
    ["Tamil digit six / CA + U", "\u0B9A\u0BC1", "\u0BEC"],
    ["Tamil thousand / CA + UU", "\u0B9A\u0BC2", "\u0BF2"],
    ["Tamil number sign / NA + II", "\u0BA8\u0BC0", "\u0BFA"],
    ["Tamil month sign / MA + II", "\u0BAE\u0BC0", "\u0BF4"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["Telugu Hari / Vari", "\u0C39\u0C30\u0C3F", "\u0C35\u0C30\u0C3F"],
    ["Telugu Rama / Raama", "\u0C30\u0C2E", "\u0C30\u0C3E\u0C2E"],
    ["Tamil Raja / Raj", "\u0BB0\u0BBE\u0B9C\u0BBE", "\u0BB0\u0BBE\u0B9C\u0BCD"],
    ["Tamil Gowri / Gouri with O", "\u0B95\u0BCC\u0BB0\u0BBF", "\u0B95\u0BCA\u0BB0\u0BBF"],
    ["Malayalam Nandu / Nanda", "\u0D28\u0D28\u0D4D\u0D26\u0D41", "\u0D28\u0D28\u0D4D\u0D26"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-357: NFD splits the Sinhala long E and long O signs into the short one and an al-lakuna, which the keys dropped
// with the other viramas.
describe("Sinhala long E and long O (EXP-357)", () => {
  it.each([
    ["Devi / short E", "\u0DAF\u0DDA\u0DC0\u0DD2", "\u0DAF\u0DD9\u0DC0\u0DD2"],
    ["Soma / short O", "\u0DC3\u0DDD\u0DB8\u0DCF", "\u0DC3\u0DDC\u0DB8\u0DCF"],
    ["kee / ke", "\u0D9A\u0DDA", "\u0D9A\u0DD9"],
  ])("%s are different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  it.each([
    ["long E typed as kombuva + al-lakuna", "\u0D9A\u0DD9\u0DCA", "\u0D9A\u0DDA"],
    ["long O typed as kombuva + aela-pilla + al-lakuna", "\u0D9A\u0DD9\u0DCF\u0DCA", "\u0D9A\u0DDD"],
    // The al-lakuna on a consonant still doesn't make another name
    ["al-lakuna on a consonant", "\u0D9A\u0DCA", "\u0D9A"],
    ["al-lakuna after the aela-pilla alone", "\u0D9A\u0DCF\u0DCA", "\u0D9A\u0DCF"],
  ])("%s is the same name", (_label, a, b) => {
    expect(isValidUsername(a)).toBe(true);
    expect(clash(a, b)).toBe("same");
  });

  // Android draws the candrabindu over a kombuva where the al-lakuna of the long vowel goes
  it.each([
    ["Devi / short E + candrabindu", "\u0DAF\u0DDA\u0DC0\u0DD2", "\u0DAF\u0DD9\u0D81\u0DC0\u0DD2"],
    ["kee / ke + candrabindu", "\u0D9A\u0DDA", "\u0D9A\u0DD9\u0D81"],
    ["koo / ko + candrabindu", "\u0D9A\u0DDD", "\u0D9A\u0DDC\u0D81"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it("still reads a candrabindu on a bare letter as no mark", () => {
    expect(isValidUsername("\u0D9A\u0D81\u0DB8")).toBe(true);
    expect(clash("\u0D9A\u0D81\u0DB8", "\u0D9A\u0DB8")).toBe("same");
  });
});

// EXP-362: the candra O (sign and letter) draws as AA + candra E, so a candrabindu over AA, which differs by a dot,
// draws almost alike; so do the candra E and candra A letters and E or A + candrabindu.
describe("Devanagari and Gujarati candra O and candrabindu (EXP-362)", () => {
  it.each([
    ["Chandni, candrabindu / candra O", "\u091A\u093E\u0901\u0926\u0928\u0940", "\u091A\u0949\u0926\u0928\u0940"],
    ["Devanagari Aanchal with candrabindu / candra O letter", "\u0906\u0901\u091A\u0932", "\u0911\u091A\u0932"],
    ["Devanagari E + candrabindu / candra E letter", "\u090F\u0901\u0915", "\u090D\u0915"],
    ["Marathi A + candrabindu / candra A letter", "\u0905\u0901\u0928\u093E", "\u0972\u0928\u093E"],
    ["Gujarati AA + candrabindu / candra O", "\u0A9A\u0ABE\u0A81\u0AA6", "\u0A9A\u0AC9\u0AA6"],
    ["Gujarati AA letter + candrabindu / candra O letter", "\u0A86\u0A81\u0A9A\u0AB2", "\u0A91\u0A9A\u0AB2"],
    ["Gujarati A + candrabindu / candra E letter", "\u0A85\u0A81\u0A95", "\u0A8D\u0A95"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["Dolly / Daali (candra O and AA)", "\u0921\u0949\u0932\u0940", "\u0921\u093E\u0932\u0940"],
    ["Oscar / Aaskar (candra O and AA letters)", "\u0911\u0938\u094D\u0915\u0930", "\u0906\u0938\u094D\u0915\u0930"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-362: rare marks drawn where a vowel sign goes hide it, and the keys keep the sign but drop the mark.
describe("rare Indic marks next to a vowel sign (EXP-362)", () => {
  it.each([
    ["Gurmukhi yakash + U", "\u0A30\u0A3E\u0A1C\u0A41\u0A75"],
    ["Gurmukhi yakash before U", "\u0A30\u0A3E\u0A1C\u0A75\u0A41"],
    ["Gurmukhi yakash + AA", "\u0A15\u0A75\u0A3E"],
    ["Gujarati sukun + E", "\u0A95\u0AC7\u0AFA"],
    ["Gujarati shadda + AI", "\u0A95\u0AC8\u0AFB"],
    ["Gujarati maddah + candra E", "\u0A95\u0AC5\u0AFC"],
    ["Gujarati three-dot nukta above + I", "\u0A95\u0ABF\u0AFD"],
    ["Gujarati circle nukta above + E", "\u0A95\u0AFE\u0AC7"],
    ["Gujarati two-circle nukta above + O", "\u0A95\u0ACB\u0AFF"],
  ])("%s is refused", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it.each([
    ["Gurmukhi yakash alone", "\u0A15\u0A75"],
    ["Gujarati sukun alone", "\u0A95\u0AFA"],
    ["Gujarati circle nukta above alone", "\u0A95\u0AFE\u0AA8"],
  ])("%s stays valid", (_label, name) => {
    expect(isValidUsername(name)).toBe(true);
  });
});

// The visual keys read Indic characters decomposed, so every entry of the table holds for the characters that
// canonically contain it, typed composed or decomposed (Tamil letter AU is O + AU length mark).
describe("Indic lookalikes and canonical equivalence", () => {
  const LAST_CODE_POINT = 0x10ffff;
  const holdingAnEntry = Array.from({ length: LAST_CODE_POINT + 1 }, (_, codePoint) => codePoint)
    .filter((codePoint) => codePoint < 0xd800 || codePoint > 0xdfff)
    .map((codePoint) => String.fromCodePoint(codePoint))
    .filter((char) => char.normalize("NFD") !== char
      && Array.from(char.normalize("NFD")).some((part) => INDIC_LOOKALIKES.has(part)));

  it("finds the composed characters that hold an entry (Tamil O, OO and AU signs, the letter AU)", () => {
    expect(holdingAnEntry).toEqual(expect.arrayContaining(["\u0BCA", "\u0BCB", "\u0BCC", "\u0B94"]));
  });

  it("gives each of them, composed and decomposed, the same visual keys", () => {
    const differing = holdingAnEntry.filter((char) => {
      const decomposed = char.normalize("NFD");
      return visualKey(char) !== visualKey(decomposed) || letterVisualKey(char) !== letterVisualKey(decomposed);
    });
    expect(differing).toEqual([]);
  });
});
