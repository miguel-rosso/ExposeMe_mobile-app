import { describe, expect, it } from "vitest";
import { UNASSIGNED_NON_EMOJI_RANGES } from "../managers/asciiConfusables";
import {
  JOINER_SCRIPTS, LATIN_LOOKALIKE_SCRIPTS, MUSICAL_SPACING_MARK, SPACING_MARK_SCRIPTS,
} from "../managers/playerName";
import { codePointClass } from "../managers/textGlyphs";

// EXP-032: the name rules build their regexes from script names when the module loads. A script newer than the
// Unicode version of the oldest supported Node (engines >=20.9: Unicode 15.1) would throw there and stop the server
// from starting, so this file also runs on Node 20 when a script is added.
const SCRIPTS = [...JOINER_SCRIPTS, ...LATIN_LOOKALIKE_SCRIPTS, ...SPACING_MARK_SCRIPTS];
// Scripts added in Unicode 16 (Node 22+ only)
const UNICODE_16_SCRIPTS = ["Garay", "Gurung_Khema", "Kirat_Rai", "Ol_Onal", "Sunuwar", "Todhri", "Tulu_Tigalari"];
const MAX_CODE_POINT = 0x10FFFF;

describe("script names used by the name rules", () => {
  it.each(SCRIPTS)("%s compiles as a Script and a Script_Extensions class", (name) => {
    expect(() => new RegExp(`\\p{Script=${name}}\\p{Script_Extensions=${name}}`, "u")).not.toThrow();
  });

  it("names no script newer than Unicode 15.1", () => {
    expect(SCRIPTS.filter((name) => UNICODE_16_SCRIPTS.includes(name))).toEqual([]);
  });

  // EXP-456: a spacing mark whose scripts are all left out of the list would be refused on every letter, its own too
  it("lists a script of every spacing mark a name can hold (assigned in Unicode 15.1) but the musical ones", () => {
    const unassigned = new RegExp(codePointClass(UNASSIGNED_NON_EMOJI_RANGES), "u");
    const listed = SPACING_MARK_SCRIPTS.map((name) => new RegExp(`^\\p{Script_Extensions=${name}}$`, "u"));
    const unlisted: string[] = [];
    for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint++) {
      const char = String.fromCodePoint(codePoint);
      if (!/^\p{Mc}$/u.test(char) || unassigned.test(char) || MUSICAL_SPACING_MARK.test(char)) continue;
      if (!listed.some((pattern) => pattern.test(char))) unlisted.push(codePoint.toString(16));
    }
    expect(unlisted).toEqual([]);
  });
});
