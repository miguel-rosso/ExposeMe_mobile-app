import { performance } from "perf_hooks";
import { describe, expect, it } from "vitest";
import { MAX_CHAT_LINE_BREAKS, normalizeChatText } from "../managers/chatText";
import { MAX_STACKED_MARKS } from "../managers/textGlyphs";

// EXP-447: chat text is relayed, logged and reported as typed (no word filter, DEC-060), except the characters that
// break the bubble's layout or hide or reorder the text: those are normalised, and a message left with nothing to see
// is dropped (null).

describe("normalizeChatText", () => {
  it("keeps ordinary text, words, accents, emoji and other scripts exactly as typed", () => {
    for (const text of [
      "qué p.u.t.a foto 😂",
      "¯\\_(ツ)_/¯ <3",
      "👨\u200D👩\u200D👧 family, 👩🏽\u200D💻 at work, 🏳️\u200D🌈, ❤️\u200D🔥, 1️⃣",
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} England",
      "می\u200Cخواهم", // Persian half-space (zero-width non-joiner)
      "क्\u200Dष श्री", // Devanagari half form (virama + zero-width joiner)
      "עברית \u200F(RTL mark) و العربية",
      "Tiếng Việt, ελληνικά, 日本語、한국어",
      "a\u00A0b", // no-break space, as French keyboards put before «:»
      // Burmese: spacing vowel signs (Mc) between the stacking marks of a letter (EXP-454)
      "\u101C\u103B\u103E\u1031\u102C\u1037",
      "\u101C\u103B\u103E\u1031\u102C\u1037\u1001\u103B",
      "\u0D32\u0D4D\u200D \u0D15\u0D4D\u200D", // Malayalam chillus typed as consonant + virama + joiner
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
      "/\\_/\\\n( o.o )\n > ^ <", // ASCII art: indentation after a line break stays
    ]) expect(normalizeChatText(text)).toBe(text);
  });

  it("drops bidi overrides and isolates, which reorder what a reader (or a report reviewer) sees", () => {
    expect(normalizeChatText("abc\u202Edcba\u202C!")).toBe("abcdcba!");
    expect(normalizeChatText("\u2066x\u2067y\u2068z\u2069 \u202Aa\u202Bb\u202Dc")).toBe("xyz abc");
  });

  it("drops invisible characters: zero-width spaces, word joiners, BOM, soft hyphens, fillers, stray tags", () => {
    expect(normalizeChatText("h\u200Bo\u2060l\uFEFFa\u00AD!")).toBe("hola!");
    expect(normalizeChatText("hi\u3164\uFFA0\u034F\u2061")).toBe("hi");
    // Tag characters outside a flag are hidden text
    expect(normalizeChatText("ok\u{E0068}\u{E0069}\u{E007F}")).toBe("ok");
    expect(normalizeChatText("\u{1F3F4}\u{E0068}\u{E0069}\u{E0064}\u{E0064}\u{E0065}\u{E006E}\u{E0020}\u{E0074}\u{E0065}\u{E0078}\u{E0074}\u{E007F}"))
      .toBe("\u{1F3F4}");
    // Only the subdivision flags of the emoji list carry tags: a well-formed but unlisted one is hidden text too
    expect(normalizeChatText("\u{1F3F4}\u{E0068}\u{E0069}\u{E0064}\u{E0065}\u{E007F}")).toBe("\u{1F3F4}");
  });

  // As in player names: between letters of a script spelled with joiners, after a virama on one, or ZWJ between emoji
  it("keeps one joiner only where it shapes a script or an emoji, and drops the rest (no hidden text)", () => {
    expect(normalizeChatText("x" + "\u200D".repeat(50))).toBe("x");
    expect(normalizeChatText("\u200D".repeat(50) + "x")).toBe("x");
    expect(normalizeChatText("a\u200Db a\u200Cb")).toBe("ab ab");
    expect(normalizeChatText("a \u200D b")).toBe("a  b");
    expect(normalizeChatText("\u0645\u200C\u200C\u200C\u062E")).toBe("\u0645\u200C\u062E");
    expect(normalizeChatText("\u0645\u200C \u062E")).toBe("\u0645 \u062E");
    expect(normalizeChatText("\u0915\u094D\u200D\u200D\u200D")).toBe("\u0915\u094D\u200D");
    expect(normalizeChatText("\u0915\u093F\u200D")).toBe("\u0915\u093F"); // a vowel sign is no virama
    expect(normalizeChatText("\u{1F600}\u200C\u{1F600} \u{1F600}\u200Dx")).toBe("\u{1F600}\u{1F600} \u{1F600}x");
  });

  // EXP-447: a flood of messages full of joiners must not cost much more than plain text (it once grew with the square
  // of the message's length)
  it("normalises a message full of joiners about as fast as plain text", () => {
    const CALLS = 2_000;
    const timePerCall = (text: string) => {
      for (let i = 0; i < CALLS; i++) normalizeChatText(text); // warm-up
      const start = performance.now();
      for (let i = 0; i < CALLS; i++) normalizeChatText(text);
      return (performance.now() - start) / CALLS;
    };
    const plain = timePerCall("ab".repeat(50));
    const joiners = timePerCall("a\u200D".repeat(50));
    expect(joiners).toBeLessThan(plain * 4);
  });

  it("drops control characters but line breaks, which become \\n, and tabs, which become spaces", () => {
    expect(normalizeChatText("a\u0000b\u0007c\u001Bd\u007Fe\u009Bf")).toBe("abcdef");
    expect(normalizeChatText("a\tb")).toBe("a b");
    expect(normalizeChatText("a\r\nb\rc\u2028d")).toBe("a\nb\nc\nd");
    expect(normalizeChatText("a\u2029b\u0085c\vd")).toBe("a\nb\nc\nd");
    // A lone surrogate is no character at all
    expect(normalizeChatText("a\uD800b")).toBe("ab");
  });

  it(`keeps at most ${MAX_CHAT_LINE_BREAKS} line breaks, with no blank lines; the rest become spaces`, () => {
    expect(normalizeChatText("a\n\n\n\nb")).toBe("a\nb");
    expect(normalizeChatText("a  \n \n\n   b\n\t c")).toBe("a\n   b\n  c");
    expect(normalizeChatText("1\n2\n3\n4\n5\n6")).toBe("1\n2\n3\n4 5 6");
    expect(normalizeChatText("x" + "\n".repeat(98) + "y")).toBe("x\ny");
    expect(normalizeChatText("\n\n  hola  \n\n")).toBe("hola");
  });

  it(`keeps at most ${MAX_STACKED_MARKS} stacking marks on a letter (Zalgo), whatever invisible ones sit between`, () => {
    const pile = "\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308";
    expect(normalizeChatText(`Z${pile}a${pile}`)).toBe("Z\u0301\u0302\u0303\u0304a\u0301\u0302\u0303\u0304");
    // (only the joiner right after the letter's marks can shape anything: those between marks go too)
    expect(normalizeChatText(`o${"\u0301\u200D".repeat(10)}`)).toBe("o\u0301\u0301\u0301\u0301");
    // A grapheme joiner between marks doesn't start a new pile: it goes (invisible), and so does the excess
    expect(normalizeChatText(`e${"\u0301\u034F".repeat(10)}`)).toBe("e\u0301\u0301\u0301\u0301");
    // Nor do the bidi marks or the Mongolian vowel separator
    for (const between of ["\u200E", "\u200F", "\u061C", "\u180E"]) {
      expect(normalizeChatText(`a${("\u0301" + between).repeat(10)}`)).toBe(`a${("\u0301" + between).repeat(4)}`);
    }
    // Spacing marks (Mc) don't count and stay; the stacking ones past the cap go
    expect(normalizeChatText(`\u101C${"\u1036\u103B".repeat(6)}`))
      .toBe(`\u101C${"\u1036\u103B".repeat(4)}${"\u103B".repeat(2)}`);
  });

  // Code points reserved for emoji but unknown to the running Node are a newer emoji, drawn by the phone
  it("keeps a message that is only an emoji newer than the server's Unicode", () => {
    expect(normalizeChatText("\u{1FAFA}")).toBe("\u{1FAFA}");
  });

  it("returns null for a message with nothing to see once normalised", () => {
    for (const text of [
      "", "   ", "\n\n\n", "\u200B\u200B", "\u202E", "\u3164", "\u2800\u2800", "\u200D", "\u200F", "\u0301\u0302",
      "\u0000\u0001", "\uFFFC", "\uFE0F", "\u{E0068}\u{E0069}", "\u0378", "\u{50000}\u{50001}", "\u{1FBFF}",
    ]) expect(normalizeChatText(text)).toBeNull();
  });
});
