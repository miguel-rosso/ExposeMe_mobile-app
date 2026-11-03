import { describe, expect, it } from "vitest";
import { INDIC_CONFUSABLES } from "../managers/asciiConfusables";
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

// EXP-364: the table generated from UTS #39 reads the Indic letters, digits and signs drawn like another spelling of
// their script (Kannada and Telugu as one).
describe("Indic characters drawn like another spelling of their script (EXP-364)", () => {
  it.each([
    ["Tamil Kannan / digit one for KA", "\u0B95\u0BA3\u0BCD\u0BA3\u0BA9\u0BCD", "\u0BE7\u0BA3\u0BCD\u0BA3\u0BA9\u0BCD"],
    ["Tamil Arun / digit eight for A", "\u0B85\u0BB0\u0BC1\u0BA3\u0BCD", "\u0BEE\u0BB0\u0BC1\u0BA3\u0BCD"],
    ["Tamil Uma / digit two for U", "\u0B89\u0BAE\u0BBE", "\u0BE8\u0BAE\u0BBE"],
    ["Tamil Charan / digit four for CA", "\u0B9A\u0BB0\u0BA3\u0BCD", "\u0BEA\u0BB0\u0BA3\u0BCD"],
    ["Tamil Ezhil / digit seven for E", "\u0B8E\u0BB4\u0BBF\u0BB2\u0BCD", "\u0BED\u0BB4\u0BBF\u0BB2\u0BCD"],
    ["Tamil Yamuna / number ten for YA", "\u0BAF\u0BAE\u0BC1\u0BA9\u0BBE", "\u0BF0\u0BAE\u0BC1\u0BA9\u0BBE"],
    ["Tamil Janani / AI for JA", "\u0B9C\u0BA9\u0BA9\u0BBF", "\u0B90\u0BA9\u0BA9\u0BBF"],
    ["Tamil SA / SHA", "\u0BB8\u0BB0\u0BA3\u0BCD", "\u0BB6\u0BB0\u0BA3\u0BCD"],
    ["Tamil Urmila / U + LLA for UU", "\u0B8A\u0BB0\u0BCD\u0BAE\u0BBF\u0BB3\u0BBE",
      "\u0B89\u0BB3\u0BB0\u0BCD\u0BAE\u0BBF\u0BB3\u0BBE"],
    ["Malayalam Rani / RRA for RA", "\u0D30\u0D3E\u0D23\u0D3F", "\u0D31\u0D3E\u0D23\u0D3F"],
    ["Malayalam NYA / vocalic LL", "\u0D15\u0D1E", "\u0D15\u0D61"],
    ["Malayalam Prasanna / digit six for NNA", "\u0D2A\u0D4D\u0D30\u0D38\u0D28\u0D4D\u0D28",
      "\u0D2A\u0D4D\u0D30\u0D38\u0D6C"],
    ["Sinhala Eranga / PHA for E", "\u0D91\u0DBB\u0D82\u0D9C", "\u0DB5\u0DBB\u0D82\u0D9C"],
    ["Sinhala O / AMBA BA", "\u0D94\u0DB6", "\u0DB9\u0DB6"],
    ["Sinhala Bandara / KHA for BA", "\u0DB6\u0DAB\u0DCA\u0DA9\u0DCF\u0DBB", "\u0D9B\u0DAB\u0DCA\u0DA9\u0DCF\u0DBB"],
    ["Sinhala Chamari / VA for CA", "\u0DA0\u0DB8\u0DBB\u0DD2", "\u0DC0\u0DB8\u0DBB\u0DD2"],
    ["Sinhala Hasini / BHA for HA", "\u0DC4\u0DC3\u0DD2\u0DB1\u0DD2", "\u0DB7\u0DC3\u0DD2\u0DB1\u0DD2"],
    ["Assamese and Bengali Raj", "\u09F0\u09BE\u099C", "\u09B0\u09BE\u099C"],
    ["Kannada and Telugu Anil", "\u0C85\u0CA8\u0CBF\u0CB2\u0CCD", "\u0C05\u0C28\u0C3F\u0C32\u0C4D"],
    ["Kannada and Telugu Jaya", "\u0C9C\u0CAF", "\u0C1C\u0C2F"],
    ["Kannada and Telugu OO", "\u0C93", "\u0C13"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  // The keys drop viramas and Latin-style dots, so letters UTS #39 draws with one would read as the bare letters
  it.each([
    ["Malayalam Kamal / Kamala (chillu L)", "\u0D15\u0D2E\u0D7D", "\u0D15\u0D2E\u0D32"],
    ["Malayalam Nandan / Nandana (chillu N)", "\u0D28\u0D28\u0D4D\u0D26\u0D7B", "\u0D28\u0D28\u0D4D\u0D26\u0D28"],
    ["Telugu Bhanu / Banu", "\u0C2D\u0C3E\u0C28\u0C41", "\u0C2C\u0C3E\u0C28\u0C41"],
    ["Devanagari Isha / RA + I", "\u0908\u0936\u093E", "\u0930\u0907\u0936\u093E"],
    ["Sinhala EE / E", "\u0D92\u0D9A", "\u0D91\u0D9A"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  it("keeps each generated entry within one script, Kannada counted as Telugu, but the reviewed ones (EXP-375)", () => {
    const scriptOf = (char: string) => {
      const block = Math.floor(char.codePointAt(0)! / 0x80);
      return block === 0x0c80 / 0x80 ? 0x0c00 / 0x80 : block;
    };
    const mixed = [...INDIC_CONFUSABLES].filter(([char, spelling]) =>
      Array.from(spelling).some((part) => scriptOf(part) !== scriptOf(char)));
    expect(mixed.map(([char]) => char)).toEqual(REVIEWED_CROSS_SCRIPT);
  });

  it("reads no spelling of the table again, and lets no measured entry replace a generated one", () => {
    const readAgain = [...INDIC_LOOKALIKES].filter(([, spelling]) =>
      Array.from(spelling).some((part) => INDIC_LOOKALIKES.has(part)));
    expect(readAgain).toEqual([]);
    const replaced = [...INDIC_CONFUSABLES].filter(([char, spelling]) =>
      INDIC_LOOKALIKES.get(char) !== Array.from(spelling, (part) => INDIC_LOOKALIKES.get(part) ?? part).join(""));
    expect(replaced).toEqual([]);
  });
});

// EXP-375: the cross-script pairs of UTS #39 that render essentially alike (scripts/generateAsciiConfusables.mjs,
// CROSS_SCRIPT_INDIC), in code point order: a name may mix Indic scripts letter by letter, so one swapped letter copies
// a name of the sister script. The Gujarati letter RA is read as the Gujarati digit two, a step of its UTS #39 entry,
// so it stays within its script.
const REVIEWED_CROSS_SCRIPT = [
  "\u093F", "\u0A1F", "\u0A20", "\u0A24", "\u0A2B", "\u0A38", "\u0A3F", "\u0A48", "\u0ABD", "\u0AEA", "\u0AEE",
  "\u0D16", "\u0D25", "\u0D3F",
];

describe("Indic characters drawn like one of a sister script (EXP-375)", () => {
  it.each([
    ["Devanagari Umesh / Gurmukhi TA for U", "\u0909\u092E\u0947\u0936", "\u0A24\u092E\u0947\u0936"],
    ["Devanagari Kamal / Gurmukhi SA for MA", "\u0915\u092E\u0932", "\u0915\u0A38\u0932"],
    ["Devanagari Pathak / Gurmukhi TTHA for TTHA", "\u092A\u093E\u0920\u0915", "\u092A\u093E\u0A20\u0915"],
    ["Devanagari Dhal / Gurmukhi PHA for DDHA", "\u0922\u0932", "\u0A2B\u0932"],
    ["Devanagari Tagore / Gurmukhi TTAI", "\u091F\u0948\u0917\u094B\u0930", "\u0A1F\u0A48\u0917\u094B\u0930"],
    ["Devanagari Tiya / Gurmukhi TTI", "\u091F\u093F\u092F\u093E", "\u0A1F\u0A3F\u092F\u093E"],
    ["Devanagari Tina / Gurmukhi TTII (EXP-375)", "\u091F\u0940\u0928\u093E", "\u0A1F\u0A40\u0928\u093E"],
    ["Devanagari Tej / Gurmukhi TTEE (EXP-386)", "\u091F\u0947\u091C", "\u0A1F\u0A47\u091C"],
    ["Devanagari Sumit / Gurmukhi SA for MA with II", "\u0938\u0941\u092E\u0940\u0924", "\u0938\u0941\u0A38\u0A40\u0924"],
    ["Gujarati Kar / digit two for RA", "\u0A95\u0AB0", "\u0A95\u0AE8"],
    ["Devanagari Ram 4 / Gujarati four", "\u0930\u093E\u092E\u096A", "\u0930\u093E\u092E\u0AEA"],
    ["Devanagari Ram 8 / Gujarati eight", "\u0930\u093E\u092E\u096E", "\u0930\u093E\u092E\u0AEE"],
    ["Devanagari Haa with avagraha / Gujarati avagraha", "\u0939\u093E\u093D", "\u0939\u093E\u0ABD"],
    ["Tamil Kumaran / Malayalam THA for MA", "\u0B95\u0BC1\u0BAE\u0BB0\u0BA9\u0BCD", "\u0B95\u0BC1\u0D25\u0BB0\u0BA9\u0BCD"],
    ["Tamil Vanitha / Malayalam KHA for VA", "\u0BB5\u0BA9\u0BBF\u0BA4\u0BBE", "\u0D16\u0BA9\u0BBF\u0BA4\u0BBE"],
    ["Tamil Vimal / Malayalam KHI for VI", "\u0BB5\u0BBF\u0BAE\u0BB2\u0BCD", "\u0D16\u0D3F\u0BAE\u0BB2\u0BCD"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  // Close shapes UTS #39 lists but the fonts draw apart, and real names of one script the pairs must not join
  it.each([
    ["Devanagari Pal / Gurmukhi DHA (hooked stem)", "\u092A\u0932", "\u0A27\u0932"],
    ["Devanagari Bhan / Gurmukhi MA (Noto curls BHA)", "\u092D\u0928", "\u0A2E\u0928"],
    ["Devanagari Ram 2 / Gujarati two (straight tail)", "\u0930\u093E\u092E\u0968", "\u0930\u093E\u092E\u0AE8"],
    ["Tamil Ganapathi / Malayalam NNA for NNA", "\u0B95\u0BA3\u0BAA\u0BA4\u0BBF", "\u0B95\u0D23\u0BAA\u0BA4\u0BBF"],
    ["Malayalam Kiran / Keeran (I and II signs)", "\u0D15\u0D3F\u0D30\u0D7A", "\u0D15\u0D40\u0D30\u0D7A"],
    ["Gurmukhi Sant / Mant", "\u0A38\u0A70\u0A24", "\u0A2E\u0A70\u0A24"],
    ["Gujarati Raj / Kaj", "\u0AB0\u0ABE\u0A9C", "\u0A95\u0ABE\u0A9C"],
    // Vowel signs drawn apart from the sister script's (playerName CROSS_SCRIPT_VOWEL_SIGN_LOOKALIKES, "Left out")
    ["Devanagari Seema / Gurmukhi SA + kanna (half-height AA)", "\u0938\u0940\u092E\u093E", "\u0938\u0940\u0A38\u0A3E"],
    ["Devanagari Thakur / Gurmukhi TTHA + kanna", "\u0920\u093E\u0915\u0941\u0930", "\u0A20\u0A3E\u0915\u0941\u0930"],
    ["Devanagari Tuktuk / Gurmukhi TTU (other hook)", "\u091F\u0941\u0915", "\u0A1F\u0A41\u0915"],
    ["Devanagari Teri / Gurmukhi TTOO (OO would meet EE)", "\u091F\u0947\u0930\u0940", "\u0A1F\u0A4B\u0930\u0940"],
    ["Gurmukhi Sohan / Sehan (OO and EE signs)", "\u0A38\u0A4B\u0A39\u0A28", "\u0A38\u0A47\u0A39\u0A28"],
    ["Tamil Vaani / Malayalam KHA + AA", "\u0BB5\u0BBE\u0BA3\u0BBF", "\u0D16\u0D3E\u0BA3\u0BBF"],
    ["Tamil Maaran / Malayalam THA + AA", "\u0BAE\u0BBE\u0BB1\u0BA9\u0BCD", "\u0D25\u0D3E\u0BB1\u0BA9\u0BCD"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-365: the Tamil vowel sign AI is drawn before its letter, and UTS #39 draws it like the letter NNNA.
describe("Tamil vowel sign AI read where it is drawn (EXP-365)", () => {
  it.each([
    ["KAI / NNNA + KA", "\u0B95\u0BC8", "\u0BA9\u0B95"],
    ["Maithili / NNNA + MA", "\u0BAE\u0BC8\u0BA4\u0BBF\u0BB2\u0BBF", "\u0BA9\u0BAE\u0BA4\u0BBF\u0BB2\u0BBF"],
    ["Vaigai / NNNA + VA, NNNA + KA", "\u0BB5\u0BC8\u0B95\u0BC8", "\u0BA9\u0BB5\u0BA9\u0B95"],
    ["KAI with an anusvara / NNNA + KA + anusvara", "\u0B95\u0B82\u0BC8", "\u0BA9\u0B95\u0B82"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["KAI / KA + NNNA", "\u0B95\u0BC8", "\u0B95\u0BA9"],
    ["Vaigai / VA + NNNA + KA + NNNA", "\u0BB5\u0BC8\u0B95\u0BC8", "\u0BB5\u0BA9\u0B95\u0BA9"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });
});

// EXP-372: the Tamil sign AI is drawn before the whole KSSA ligature (KA + virama + SSA), not before its SSA.
describe("Tamil vowel sign AI on the KSSA ligature (EXP-372)", () => {
  it("reads KSSAI like NNNA + KSSA", () => {
    expectSimilar("\u0B95\u0BCD\u0BB7\u0BC8", "\u0BA9\u0B95\u0BCD\u0BB7");
  });

  it("keeps KSSAI apart from KA + virama + NNNA + SSA", () => {
    expectDistinct("\u0B95\u0BCD\u0BB7\u0BC8", "\u0B95\u0BCD\u0BA9\u0BB7");
  });

  // A joiner or non-joiner after the virama breaks the ligature: KA is drawn with its visible virama, then AI + SSA
  it.each([
    ["joiner", "\u0B95\u0BCD\u200D\u0BB7\u0BC8"],
    ["non-joiner", "\u0B95\u0BCD\u200C\u0BB7\u0BC8"],
  ])("reads KA + virama + %s + SSA + AI like KA + virama + NNNA + SSA", (_label, name) => {
    expectSimilar(name, "\u0B95\u0BCD\u0BA9\u0BB7");
  });
});

// EXP-372: Tamil AI signs a lookalike could hide behind a joiner, a second sign or a base that isn't a Tamil letter.
describe("Tamil vowel sign AI on an odd base (EXP-372)", () => {
  it.each([
    ["KA + joiner + AI", "\u0B95\u200D\u0BC8"],
    ["KA + non-joiner + AI", "\u0B95\u200C\u0BC8"],
    ["KA + AI + AI", "\u0B95\u0BC8\u0BC8"],
    ["Tamil digit one + AI", "\u0BE7\u0BC8"],
    ["Latin a + AI", "a\u0BC8"],
    ["KA + space + AI", "\u0B95 \u0BC8"],
    ["KA + space + AI + MA", "\u0B95 \u0BC8\u0BAE"],
  ])("%s is refused", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});

// EXP-372: Malayalam chillus may still be typed the pre-Unicode 5.1 way, consonant + virama + zero-width joiner, which
// fonts draw as the atomic chillu.
describe("Malayalam chillus typed with a joiner (EXP-372)", () => {
  it.each([
    ["Anvar, chillu N", "\u0D05\u0D7B\u0D35\u0D7C", "\u0D05\u0D28\u0D4D\u200D\u0D35\u0D7C"],
    ["Kanmani, chillu NN", "\u0D15\u0D7A\u0D2E\u0D23\u0D3F", "\u0D15\u0D23\u0D4D\u200D\u0D2E\u0D23\u0D3F"],
    ["Arjun, chillu RR", "\u0D05\u0D7C\u0D1C\u0D41\u0D7B", "\u0D05\u0D30\u0D4D\u200D\u0D1C\u0D41\u0D7B"],
    ["Salman, chillu L", "\u0D38\u0D7D\u0D2E\u0D3E\u0D7B", "\u0D38\u0D32\u0D4D\u200D\u0D2E\u0D3E\u0D7B"],
    ["chillu LL before a letter", "\u0D2A\u0D7E\u0D2A", "\u0D2A\u0D33\u0D4D\u200D\u0D2A"],
    ["Vakpati, chillu K", "\u0D35\u0D3E\u0D7F\u0D2A\u0D24\u0D3F", "\u0D35\u0D3E\u0D15\u0D4D\u200D\u0D2A\u0D24\u0D3F"],
  ])("%s, atomic and with a joiner, look too alike", (_label, atomic, withJoiner) => {
    expectSimilar(atomic, withJoiner);
  });

  // The digits nine and four are drawn exactly like chillu N and chillu RR
  it.each([
    ["Anvar with a joiner / digit nine", "\u0D05\u0D28\u0D4D\u200D\u0D35\u0D7C", "\u0D05\u0D6F\u0D35\u0D7C"],
    ["Arjun with a joiner / digit four", "\u0D05\u0D30\u0D4D\u200D\u0D1C\u0D41\u0D7B", "\u0D05\u0D6A\u0D1C\u0D41\u0D7B"],
    ["Anvar with chillu N / digit nine", "\u0D05\u0D7B\u0D35\u0D7C", "\u0D05\u0D6F\u0D35\u0D7C"],
    ["Arjun with chillu RR / digit four", "\u0D05\u0D7C\u0D1C\u0D41\u0D7B", "\u0D05\u0D6A\u0D1C\u0D41\u0D7B"],
  ])("%s look too alike", (_label, a, b) => {
    expectSimilar(a, b);
  });

  it.each([
    ["Kamal / Kamala", "\u0D15\u0D2E\u0D7D", "\u0D15\u0D2E\u0D32"],
    ["Anvar / NA + VA", "\u0D05\u0D7B\u0D35\u0D7C", "\u0D05\u0D28\u0D35\u0D7C"],
    // A non-joiner keeps the virama visible instead of drawing a chillu
    ["Anvar / NA + virama + non-joiner", "\u0D05\u0D7B\u0D35\u0D7C", "\u0D05\u0D28\u0D4D\u200C\u0D35\u0D7C"],
  ])("%s stay different names", (_label, a, b) => {
    expectDistinct(a, b);
  });

  // Old keyboards type the chillu that ends a word this way too, with nothing after the joiner
  it.each([
    ["Kamal", "\u0D15\u0D2E\u0D7D", "\u0D15\u0D2E\u0D32\u0D4D\u200D"],
    ["Arjun", "\u0D05\u0D7C\u0D1C\u0D41\u0D7B", "\u0D05\u0D30\u0D4D\u200D\u0D1C\u0D41\u0D28\u0D4D\u200D"],
    ["Kamal Das, chillu before a space", "\u0D15\u0D2E\u0D7D \u0D26\u0D3E\u0D38\u0D4D", "\u0D15\u0D2E\u0D32\u0D4D\u200D \u0D26\u0D3E\u0D38\u0D4D"],
    ["chillu K before a digit", "\u0D35\u0D3E\u0D7F7", "\u0D35\u0D3E\u0D15\u0D4D\u200D7"],
    ["Kamal!, chillu before punctuation", "\u0D15\u0D2E\u0D7D!", "\u0D15\u0D2E\u0D32\u0D4D\u200D!"],
    ["Kamal with an emoji after the chillu", "\u0D15\u0D2E\u0D7D\u{1F60A}", "\u0D15\u0D2E\u0D32\u0D4D\u200D\u{1F60A}"],
  ])("%s with a chillu ending a word, atomic and with a joiner, look too alike", (_label, atomic, withJoiner) => {
    expectSimilar(atomic, withJoiner);
  });

  it.each([
    ["a joiner after a letter", "\u0D15\u0D2E\u0D32\u200D"],
    ["a joiner after a virama on a consonant with no chillu", "\u0D15\u0D2E\u0D4D\u200D"],
    ["a joiner after an atomic chillu", "\u0D15\u0D2E\u0D7D\u200D"],
    ["two joiners after the virama", "\u0D15\u0D2E\u0D32\u0D4D\u200D\u200D"],
    ["a joiner and a non-joiner after the virama", "\u0D15\u0D2E\u0D32\u0D4D\u200D\u200C"],
    ["a vowel sign after the joiner", "\u0D15\u0D2E\u0D32\u0D4D\u200D\u0D3F"],
    ["a joiner after a Tamil virama", "\u0B95\u0BAE\u0BB2\u0BCD\u200D"],
    ["a joiner after a Devanagari virama", "\u0915\u092E\u0932\u094D\u200D"],
    ["a joiner after a virama with no letter", "\u0D4D\u200D"],
    ["a joiner after a Latin letter and a Malayalam virama", "a\u0D4D\u200D"],
    // Before a letter only SCRIPT_JOINER allows the joiner: in a cursive script it would shape the next letter
    ["a legacy chillu joiner before an Adlam letter", "\u0D32\u0D4D\u200D\u{1E900}"],
    ["a legacy chillu joiner before a Mongolian letter", "\u0D32\u0D4D\u200D\u1820"],
    ["a legacy chillu joiner before an N'Ko letter", "\u0D32\u0D4D\u200D\u07CA"],
    ["a legacy chillu joiner before a Latin letter", "\u0D32\u0D4D\u200Da"],
  ])("%s is refused", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});
