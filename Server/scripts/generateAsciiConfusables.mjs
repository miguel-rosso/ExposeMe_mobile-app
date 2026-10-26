#!/usr/bin/env node
// Regenerates Server/managers/asciiConfusables.ts (EXP-032) from Unicode's confusables.txt (UTS #39):
//   curl -o /tmp/confusables.txt https://www.unicode.org/Public/security/latest/confusables.txt
//   node Server/scripts/generateAsciiConfusables.mjs /tmp/confusables.txt > Server/managers/asciiConfusables.ts
//
// Keeps every character, whatever its script or category (letters, math and box-drawing symbols, punctuation such as
// an inverted exclamation mark), whose prototype is 1-3 ASCII letters or digits once combining marks are dropped and
// Latin small capitals are read as their letter. Left out: ASCII itself (playerName.visualKey handles 1/l/I/0),
// nonspacing marks and characters that decompose to one (playerName drops them; spacing marks such as the Telugu
// anusvara are drawn like an "o" and kept), and characters that NFKC with marks dropped already turns into their
// prototype (playerName applies NFKC after this table).
// confusables.txt often lists only the capital (Cyrillic KA as "K", Greek MU as "M"): the lowercase letter, when it
// has no entry of its own, is added with the lowercase prototype ("к" as "k"), as the player sees the same shape.
// Except under an "l" prototype: capitals drawn like I share it with l, but their lowercase looks like an i (small
// Roman numeral one, full-width i, ij ligature; NFKC already reads most of them).
import { readFileSync } from "fs";

const ASCII_PROTOTYPE = /^[A-Za-z0-9]{1,3}$/;
const COMBINING_MARKS = /\p{Mn}/gu;
const NONSPACING_MARK = /\p{Mn}/u;
// confusables.txt lines: "source ;\tprototype ;\tMA\t#[*] ( source → prototype ) SOURCE NAME → PROTOTYPE NAME"
const ENTRY = /^([0-9A-F]+) ;\t([0-9A-F ]+) ;\tMA\t#\*? \( .+ \) (.+?) \u2192 /;

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

/** Whether `source` belongs in the table with this ASCII prototype (see the header for what is left out). */
const keeps = (source, prototype) => source.codePointAt(0) > 0x7f && !NONSPACING_MARK.test(source)
  && stripMarks(source) === source && ASCII_PROTOTYPE.test(prototype)
  && stripMarks(source.normalize("NFKC")) !== prototype;

const entries = new Map(Object.entries(SMALL_CAPITALS));
for (const line of text.split("\n")) {
  const match = line.match(ENTRY);
  if (!match) continue;
  const source = String.fromCodePoint(parseInt(match[1], 16));
  const prototype = asAscii(String.fromCodePoint(...match[2].trim().split(" ").map((hex) => parseInt(hex, 16))));
  if (keeps(source, prototype) && !entries.has(source)) entries.set(source, [prototype, match[3]]);
}

// Lowercase letters only listed through their capital, added once every entry of its own is in
for (const [source, [prototype, name]] of [...entries]) {
  const lower = source.toLowerCase();
  const lowerPrototype = prototype.toLowerCase();
  if (lower === source || [...lower].length !== 1 || entries.has(lower) || prototype.includes("l")) continue;
  if (!keeps(lower, lowerPrototype)) continue;
  entries.set(lower, [lowerPrototype, `lowercase of ${name}`]);
}

const sorted = [...entries].sort(([a], [b]) => a.codePointAt(0) - b.codePointAt(0));
const out = [
  `// Generated by Server/scripts/generateAsciiConfusables.mjs from Unicode confusables.txt ${version} (UTS #39). Do not edit.`,
  "// Character \u2192 the ASCII letters or digits it is drawn like (letters of any script, symbols, punctuation).",
  "export const ASCII_CONFUSABLES: Readonly<Record<string, string>> = {",
  ...sorted.map(([source, [prototype, name]]) => `  "${escape(source)}": "${prototype}", // ${name}`),
  "};",
  "",
];
process.stdout.write(out.join("\n"));
