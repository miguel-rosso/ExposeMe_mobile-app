import { describe, expect, it } from "vitest";
import { JOINER_SCRIPTS, LATIN_LOOKALIKE_SCRIPTS } from "../managers/playerName";

// EXP-032: the name rules build their regexes from script names when the module loads. A script newer than the
// Unicode version of the oldest supported Node (engines >=20.9: Unicode 15.1) would throw there and stop the server
// from starting, so this file also runs on Node 20 when a script is added.
const SCRIPTS = [...JOINER_SCRIPTS, ...LATIN_LOOKALIKE_SCRIPTS];
// Scripts added in Unicode 16 (Node 22+ only)
const UNICODE_16_SCRIPTS = ["Garay", "Gurung_Khema", "Kirat_Rai", "Ol_Onal", "Sunuwar", "Todhri", "Tulu_Tigalari"];

describe("script names used by the name rules", () => {
  it.each(SCRIPTS)("%s compiles as a Script and a Script_Extensions class", (name) => {
    expect(() => new RegExp(`\\p{Script=${name}}\\p{Script_Extensions=${name}}`, "u")).not.toThrow();
  });

  it("names no script newer than Unicode 15.1", () => {
    expect(SCRIPTS.filter((name) => UNICODE_16_SCRIPTS.includes(name))).toEqual([]);
  });
});
