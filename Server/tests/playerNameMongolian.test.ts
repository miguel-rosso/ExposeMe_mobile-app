import { describe, expect, it } from "vitest";
import { isValidUsername, nameClash, nameKeys } from "../managers/playerName";

// EXP-376: the Unicode Standard (chapter 13.2, Mongolian) encodes O and U, and OE and UE, apart for their sound, though
// "o is written identically to u in all positional forms, ö is written identically to ü in all positional forms".
// Every non-ASCII character is written as an escape, as the letters only differ by code point.

const clash = (a: string, b: string) => nameClash(nameKeys(a), nameKeys(b));

const BA = "\u182A";
const LA = "\u182F";
const TA = "\u1832";
const O = "\u1823";
const U = "\u1824";
const OE = "\u1825";
const UE = "\u1826";

describe("Mongolian vowels written alike (EXP-376)", () => {
  it.each([
    ["O / U alone", O, U],
    ["O / U first", `${O}${LA}`, `${U}${LA}`],
    ["O / U in the middle (bol / bul)", `${BA}${O}${LA}`, `${BA}${U}${LA}`],
    ["O / U last", `${BA}${O}`, `${BA}${U}`],
    ["OE / UE in the middle", `${BA}${OE}${LA}`, `${BA}${UE}${LA}`],
    ["OE / UE in two syllables", `${TA}${OE}${LA}${OE}`, `${TA}${UE}${LA}${UE}`],
  ])("%s look too alike", (_label, a, b) => {
    expect(isValidUsername(a)).toBe(true);
    expect(isValidUsername(b)).toBe(true);
    expect(clash(a, b)).toBe("similar");
  });

  // Drawn apart in a word's first syllable, where OE and UE carry one more stroke
  it("keeps O and OE apart", () => {
    expect(clash(`${BA}${O}${LA}`, `${BA}${OE}${LA}`)).toBeNull();
    expect(clash(`${BA}${U}${LA}`, `${BA}${UE}${LA}`)).toBeNull();
  });
});
