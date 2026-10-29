import { existsSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { SYMBOL_CONFUSABLES } from "../managers/asciiConfusables";
import { isValidUsername, looksLike, sameName, visualKey, voicingStandIns } from "../managers/playerName";

// EXP-317: kana and the kanji (or other kana) UTS #39 draws alike, such as katakana KA and the kanji for power, read
// as one another in the visual key ("Username too similar"), also with a voicing mark: the kanji plus a dakuten looks
// like the voiced kana. Each pair stays a different name (nameKey), as the glyphs differ a little in most fonts.
// Lookalikes are written as escapes on purpose: in source they are as hard to tell apart as on screen.

const DAKUTEN = "\u3099";
const HANDAKUTEN = "\u309A";
const HALFWIDTH_DAKUTEN = "\uFF9E";
const SPACING_DAKUTEN = "\u309B";
const SPACING_HANDAKUTEN = "\u309C";
const RING_ABOVE = "\u030A";
const DIAERESIS = "\u0308";

const KATAKANA_KA = "\u30AB";
const KANJI_POWER = "\u529B";
const KATAKANA_HA = "\u30CF";
const KANJI_EIGHT = "\u516B";
const KATAKANA_HE = "\u30D8";
const HIRAGANA_HE = "\u3078";
const KATAKANA_HO = "\u30DB";
const KANJI_TREE_HO = "\u6729";
const KATAKANA_RO = "\u30ED";
const KANJI_MOUTH = "\u53E3";
const KATAKANA_I = "\u30A4";
const KATAKANA_TO = "\u30C8";
const KATAKANA_N = "\u30F3";
const KATAKANA_RU = "\u30EB";
/** カイト (kite), the name in the report. */
const KAITO = `${KATAKANA_KA}${KATAKANA_I}${KATAKANA_TO}`;

describe("kana lookalikes", () => {
  it.each([
    ["katakana ka and kanji power", KATAKANA_KA, KANJI_POWER],
    ["katakana ta and kanji evening", "\u30BF", "\u5915"],
    ["katakana to and kanji divination", KATAKANA_TO, "\u535C"],
    ["katakana ha and kanji eight", KATAKANA_HA, KANJI_EIGHT],
    ["katakana hi and kanji spoon", "\u30D2", "\u5315"],
    ["katakana ro and kanji mouth", KATAKANA_RO, KANJI_MOUTH],
    ["katakana e and kanji work", "\u30A8", "\u5DE5"],
    ["katakana ni and kanji two", "\u30CB", "\u4E8C"],
    ["katakana he and hiragana he", KATAKANA_HE, HIRAGANA_HE],
    ["katakana i and the person radical", KATAKANA_I, "\u4EBB"],
    ["katakana mu and kanji private", "\u30E0", "\u53B6"],
    ["katakana yo and kanji snout", "\u30E8", "\u5F50"],
    ["katakana ne and the spirit radical", "\u30CD", "\u793B"],
    ["kanji 6729 and katakana ho", KANJI_TREE_HO, KATAKANA_HO],
    ["kanji 4E44 and katakana me", "\u4E44", "\u30E1"],
    ["Bamum o and katakana su", "\uA6A7", "\u30B9"],
    ["Bopomofo ee and katakana se", "\u31A4", "\u30BB"],
    ["half-width katakana ka and kanji power", "\uFF76", KANJI_POWER],
    ["half-width katakana he and hiragana he", "\uFF8D", HIRAGANA_HE],
  ])("%s look alike, alone or in a name, either way round", (_label, a, b) => {
    for (const [first, second] of [[a, b], [b, a]]) {
      expect(isValidUsername(first) && isValidUsername(second)).toBe(true);
      expect(looksLike(first, second)).toBe(true);
      expect(looksLike(`${first}${KATAKANA_I}${KATAKANA_TO}`, `${second}${KATAKANA_I}${KATAKANA_TO}`)).toBe(true);
      expect(sameName(first, second)).toBe(false);
    }
  });

  it("a name spelled with kanji drawn like its katakana is too similar (\u30AB\u30A4\u30C8)", () => {
    expect(looksLike(KAITO, `${KANJI_POWER}${KATAKANA_I}${KATAKANA_TO}`)).toBe(true);
    expect(looksLike(KAITO, `${KANJI_POWER}\u4EBB\u535C`)).toBe(true);
    expect(sameName(KAITO, `${KANJI_POWER}${KATAKANA_I}${KATAKANA_TO}`)).toBe(false);
  });

  it("every kana entry of the symbol table looks like its prototype in a name", () => {
    const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
    const entries = [...SYMBOL_CONFUSABLES].filter(([source, prototype]) => kana.test(source + prototype));
    expect(entries.length).toBeGreaterThan(30);
    expect(entries.filter(([source, prototype]) => !looksLike(`${source}${KATAKANA_RU}`, `${prototype}${KATAKANA_RU}`)))
      .toEqual([]);
  });
});

describe("kana lookalikes with voicing marks", () => {
  it.each([
    ["kanji power + dakuten as ga", `\u30AC${KATAKANA_I}${KATAKANA_TO}`, `${KANJI_POWER}${DAKUTEN}${KATAKANA_I}${KATAKANA_TO}`],
    ["kanji power + half-width dakuten as ga", "\u30AC", `${KANJI_POWER}${HALFWIDTH_DAKUTEN}`],
    ["kanji power + spacing dakuten as ga", "\u30AC", `${KANJI_POWER}${SPACING_DAKUTEN}`],
    ["kanji eight + dakuten as ba", `\u30D0${KATAKANA_N}`, `${KANJI_EIGHT}${DAKUTEN}${KATAKANA_N}`],
    ["kanji eight + handakuten as pa", `\u30D1${KATAKANA_N}`, `${KANJI_EIGHT}${HANDAKUTEN}${KATAKANA_N}`],
    ["kanji eight + spacing handakuten as pa", "\u30D1", `${KANJI_EIGHT}${SPACING_HANDAKUTEN}`],
    ["half-width ha + dakuten as kanji eight + dakuten", `\uFF8A${HALFWIDTH_DAKUTEN}`, `${KANJI_EIGHT}${DAKUTEN}`],
    ["katakana be as hiragana be", `\u30D9${KATAKANA_RU}`, `\u3079${KATAKANA_RU}`],
    ["katakana pe as hiragana pe", `\u30DA${KATAKANA_RU}`, `\u307A${KATAKANA_RU}`],
    ["kanji 6729 + handakuten as po", `\u30DD${KATAKANA_RU}`, `${KANJI_TREE_HO}${HANDAKUTEN}${KATAKANA_RU}`],
    ["kanji 6729 + dakuten as bo", "\u30DC", `${KANJI_TREE_HO}${DAKUTEN}`],
    // NFKC turns the squared katakana word into ガロン: its ga still meets the kanji + dakuten
    ["squared garon as kanji power + dakuten, kanji mouth", "\u330E", `${KANJI_POWER}${DAKUTEN}${KANJI_MOUTH}${KATAKANA_N}`],
    ["circled ka + dakuten as kanji power + dakuten", `\u32D5${DAKUTEN}`, `${KANJI_POWER}${DAKUTEN}`],
  ])("%s: %j and %j look alike", (_label, a, b) => {
    expect(isValidUsername(a) && isValidUsername(b)).toBe(true);
    expect(looksLike(a, b)).toBe(true);
    expect(looksLike(b, a)).toBe(true);
  });

  it.each([
    ["kanji power and ga", KANJI_POWER, "\u30AC"],
    ["kanji power + dakuten and ka", `${KANJI_POWER}${DAKUTEN}`, KATAKANA_KA],
    ["kanji eight + dakuten and pa", `${KANJI_EIGHT}${DAKUTEN}`, "\u30D1"],
    ["kanji eight + handakuten and ba", `${KANJI_EIGHT}${HANDAKUTEN}`, "\u30D0"],
    ["hiragana he and pe", `${HIRAGANA_HE}${KATAKANA_RU}`, `\u30DA${KATAKANA_RU}`],
    ["kanji 6729 and po", KANJI_TREE_HO, "\u30DD"],
  ])("a voicing mark still tells %s apart (%j, %j)", (_label, a, b) => {
    expect(looksLike(a, b)).toBe(false);
  });

  it("a kanji drawn like a kana counts its voicing mark as on that kana", () => {
    expect(visualKey(`${KANJI_POWER}${DAKUTEN}`)).toBe(visualKey("\u30AC"));
    expect(visualKey(`${KATAKANA_KA}${DAKUTEN}`)).toBe(visualKey("\u30AC"));
    // Without a kana to voice, a dakuten is dropped as before
    expect(visualKey(`${KANJI_MOUTH}${DAKUTEN}`)).toBe(visualKey(KANJI_MOUTH));
  });

  it.each([
    ["handakuten on kanji power (katakana ka only takes a dakuten)", `${KANJI_POWER}${HANDAKUTEN}`],
    ["ring above on kanji power", `${KANJI_POWER}${RING_ABOVE}`],
    ["ring above on kanji eight (drawn like a handakuten)", `${KANJI_EIGHT}${RING_ABOVE}${KATAKANA_N}`],
    ["diaeresis on kanji eight (drawn like a dakuten)", `${KANJI_EIGHT}${DIAERESIS}${KATAKANA_N}`],
    ["ring above on kanji 6729, whose prototype is katakana ho", `${KANJI_TREE_HO}${RING_ABOVE}`],
    ["two voicing marks on kanji eight", `${KANJI_EIGHT}${DAKUTEN}${HANDAKUTEN}`],
    ["ring above on half-width ka", `\uFF76${RING_ABOVE}`],
  ])("a name with %s is refused (%j)", (_label, name) => {
    expect(isValidUsername(name)).toBe(false);
  });

  it("marks on lookalikes of kana without a voiced form stay free, as on those kana", () => {
    expect(isValidUsername(`${KANJI_MOUTH}${RING_ABOVE}`)).toBe(true);
    expect(isValidUsername(`${KATAKANA_RO}${RING_ABOVE}`)).toBe(true);
    expect(isValidUsername(`\u4E8C${DIAERESIS}`)).toBe(true);
  });
});

describe("voicingStandIns", () => {
  it("pools the voicing marks of every kana drawn like the same prototype", () => {
    // ka takes only a dakuten, ha takes both marks: whatever their order, a symbol drawn like both takes both
    for (const kana of [["\u304B", "\u306F"], ["\u306F", "\u304B"]]) {
      const table = new Map([["#", "*"], [kana[0], "*"], [kana[1], "*"]]);
      const standIns = voicingStandIns(table);
      expect([...standIns.get("#")!].sort()).toEqual([DAKUTEN, HANDAKUTEN]);
      expect([...standIns.get("*")!].sort()).toEqual([DAKUTEN, HANDAKUTEN]);
    }
  });

  it("reads a character whose prototype is a kana as that kana", () => {
    const standIns = voicingStandIns(new Map([["#", "\u304B"]]));
    expect(standIns.get("#")).toEqual([DAKUTEN]);
  });

  it("leaves out prototypes no voiceable kana is drawn like", () => {
    expect(voicingStandIns(new Map([["#", "*"], ["\u3042", "*"]])).size).toBe(0);
  });
});

describe("real Japanese names", () => {
  it.each([
    ["\u4E8C\u90CE", "\u30CB\u90CE"], // 二郎 and ニ郎
    ["\u516B\u6728", "\u30CF\u6728"], // 八木 and ハ木
    ["\u53E3\u7530", "\u30ED\u7530"], // 口田 and ロ田
    ["\u5915\u5B50", "\u30BF\u5B50"], // 夕子 and タ子
  ])("a kanji name meets only its kana lookalike (%j, %j)", (kanji, lookalike) => {
    expect(looksLike(kanji, lookalike)).toBe(true);
    expect(sameName(kanji, lookalike)).toBe(false);
  });

  it.each([
    ["\u4E8C\u90CE", "\u6B21\u90CE"], // 二郎 and 次郎
    ["\u516B\u6728", "\u6728\u6751"], // 八木 and 木村
    ["\u53E3\u7530", "\u5C71\u7530"], // 口田 and 山田
    ["\u529B", "\u5200"], // 力 and 刀
    ["\u30BF\u30ED\u30A6", "\u592A\u90CE"], // タロウ and 太郎
    ["\u3072\u308D", "\u30D2\u30ED"], // ひろ and ヒロ: hiragana and katakana are drawn differently
  ])("different names stay different (%j, %j)", (a, b) => {
    expect(looksLike(a, b)).toBe(false);
  });
});

// ── Sweep over confusables.txt ──────────────────────

// Runs when Unicode's confusables.txt is at CONFUSABLES_TXT (default /tmp/confusables.txt), as in
// playerNameSymbols.test.ts: every UTS #39 pair of letters with a kana on one side looks alike in the visual key
const CONFUSABLES_TXT = process.env.CONFUSABLES_TXT ?? "/tmp/confusables.txt";
const ENTRY = /^([0-9A-F]+) ;\t([0-9A-F]+) ;\tMA\t/;
const KANA_LETTER = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const LETTER = /^\p{L}$/u;

describe.runIf(existsSync(CONFUSABLES_TXT))("kana entries of confusables.txt", () => {
  it("each looks like its prototype", () => {
    const pairs = readFileSync(CONFUSABLES_TXT, "utf8").split("\n").flatMap((line) => {
      const match = line.match(ENTRY);
      if (!match) return [];
      const [source, prototype] = [match[1], match[2]].map((hex) => String.fromCodePoint(parseInt(hex, 16)));
      const kanaPair = LETTER.test(source) && LETTER.test(prototype)
        && (KANA_LETTER.test(source) || KANA_LETTER.test(prototype));
      return kanaPair ? [[source, prototype]] : [];
    });
    expect(pairs.length).toBeGreaterThan(30);
    expect(pairs.filter(([source, prototype]) => !looksLike(`x${source}x`, `x${prototype}x`))
      .map(([source, prototype]) => `${source} \u2192 ${prototype}`)).toEqual([]);
  });
});
