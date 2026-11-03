import { describe, expect, it } from "vitest";
import { BLOCKED_WORDS, maskOffensiveWords } from "../managers/chatFilter";

// EXP-424: chat messages are relayed with insults, slurs and explicit sexual words (es/en) masked, first character and
// length on screen (graphemes) kept, whatever the case, accents, lookalike letters, leetspeak, stretched letters or
// separators; never inside unrelated words.

const MAX_CHAT_LENGTH = 100;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** The characters of `text` as shown on screen. */
const graphemes = (text: string) => [...GRAPHEMES.segment(text)].map(({ segment }) => segment);

/** The first character followed by one "*" per remaining character on screen. */
const masked = (word: string) => graphemes(word)[0] + "*".repeat(graphemes(word).length - 1);

/** Runs each [input, expected] case of a table. */
const expectMasks = (cases: ReadonlyArray<readonly [string, string]>) =>
  it.each(cases)("%s → %s", (input, expected) => {
    expect(maskOffensiveWords(input)).toBe(expected);
  });

describe("maskOffensiveWords: listed words", () => {
  it("masks every listed word on its own, keeping its first letter and length", () => {
    for (const word of BLOCKED_WORDS) expect(maskOffensiveWords(word), word).toBe(masked(word));
  });

  describe("ignores case and diacritics", () => {
    expectMasks([
      ["puta", "p***"],
      ["PUTA", "P***"],
      ["Pútá", "P***"],
      ["maricon", "m******"],
      ["MARICÓN", "M******"],
      ["imbecil", "i******"],
      ["coño", "c***"],
      ["CoÑo", "C***"],
    ]);
  });

  it("reads a ñ typed as n + combining tilde as ñ, masked as one character", () => {
    const decomposed = "coño".normalize("NFD");
    expect(decomposed).toHaveLength(5);
    expect(maskOffensiveWords(decomposed)).toBe("c***");
    expect(maskOffensiveWords("cono".normalize("NFD"))).toBe("cono".normalize("NFD"));
  });

  describe("reads compatibility forms: circled and fullwidth letters", () => {
    expectMasks([
      ["ⓟⓤⓣⓐ", "ⓟ***"],
      ["ⓅⓊⓉⒶ", "Ⓟ***"],
      ["ｐｕｔａ", "ｐ***"],
      ["qué ⓟⓤⓣⓐ foto", "qué ⓟ*** foto"],
    ]);
  });

  describe("reads letters of other scripts drawn like Latin ones", () => {
    expectMasks([
      ["рuta", "р***"], // Cyrillic er
      ["fuсk", "f***"], // Cyrillic es
      ["pοrn", "p***"], // Greek omicron
      ["ᴘᴜᴛᴀ", "ᴘ***"], // small capitals
      ["ΡUТА", "Ρ***"], // Greek capital rho, Cyrillic capitals te and a
    ]);
  });

  describe("reads common leetspeak", () => {
    expectMasks([
      ["p0rn", "p***"],
      ["put4", "p***"],
      ["mi3rda", "m*****"],
      ["5hit", "5***"],
      ["$hit", "$***"],
      ["a$$hole", "a******"],
      ["@sshole", "@******"],
      ["b1tch", "b****"],
      ["cu1ero", "c*****"],
      ["g1l1pollas", "g*********"],
    ]);
  });

  describe("matches stretched letters", () => {
    expectMasks([
      ["puuuuta", "p******"],
      ["puttttaaaa", "p*********"],
      ["fuuuuuck", "f*******"],
      ["shiiiiit", "s*******"],
      ["zorrrrra", "z*******"],
      ["gilipolllllas", "g************"],
    ]);
  });

  describe("matches plurals", () => {
    expectMasks([
      ["putas", "p****"],
      ["putos", "p****"],
      ["maricones", "m********"],
      ["bitches", "b******"],
      ["cunts", "c****"],
      ["spics", "s****"],
      ["pussies", "p******"],
      ["trannies", "t*******"],
      ["bastardos", "b********"],
      ["putaaasss", "p********"],
    ]);
  });

  describe("matches separators inside the word", () => {
    expectMasks([
      ["p.u.t.a", "p******"],
      ["p-u-t-a", "p******"],
      ["p_u_t_a", "p******"],
      ["pu.ta", "p****"],
      ["f.u.c.k", "f******"],
      ["f*u*c*k", "f******"],
      ["p u t a", "p******"],
      ["s h i t", "s******"],
      ["p.u t.a", "p******"],
      ["p 😀 u 😀 t 😀 a", "p************"],
    ]);
  });

  describe("finds spaced letters inside a longer run of single letters", () => {
    expectMasks([
      ["y p u t a", "y p******"],
      ["a p u t a", "a p******"],
      ["dije y p u t a y me fui", "dije y p****** y me fui"],
      ["a.p.u.t.a", "a.p******"],
    ]);
  });
});

describe("maskOffensiveWords: everything else is left as sent", () => {
  // Listed words inside unrelated ones, near-misses and harmless words that normalise close to a listed one
  const harmless = [
    // Spanish
    "computadora", "disputa", "disputar", "reputación", "imputado", "diputado", "matizar", "cono", "pola", "zora",
    "follaje", "pollo", "pollito", "cabra", "mamá", "jota", "culto", "verano", "chinga", "puré", "putt", "pública",
    "a ver", "y o", "e s o", "computa", "Kike", "kike", "Kikes", "Kike, ¿vienes?", "la polla del mundial",
    // English
    "Scunthorpe", "assistant", "Essex", "Sussex", "class", "classic", "bass", "pass", "as", "cocktail", "shitake",
    "therapist", "analysis", "Dickens", "pussycat", "porcelain", "kitchen", "specific", "skyscraper", "fagus",
    "spice", "spices", "title", "twattle", "poorness", "mammon", "assess", "cumulative", "dickensian", "bitcoin",
    "shuttle",
    // Leetspeak-looking text that isn't a listed word
    "h0la", "1000", "c4rr0", "2024", "l33t", "$100", "@miguel",
    // Other scripts and symbols that aren't a listed word
    "привет", "καλημέρα", "ⓗⓞⓛⓐ", "½ pizza",
  ];

  it.each(harmless)("%s", (text) => {
    expect(maskOffensiveWords(text)).toBe(text);
  });

  it("a doubled letter is not a stretched one (the price of reading 'poorness' and 'mammon' as normal words)", () => {
    expect(maskOffensiveWords("puuta")).toBe("puuta");
    expect(maskOffensiveWords("puuuta")).toBe("p*****");
  });

  it("keeps the message untouched when it has nothing to mask (emoji, punctuation and spacing included)", () => {
    const text = "¡Hola! ¿Quién es? 😂😂 la foto de   Essex… computadora, disputa; assistant.";
    expect(maskOffensiveWords(text)).toBe(text);
  });
});

describe("maskOffensiveWords: mixed sentences", () => {
  expectMasks([
    ["eres un puto genio", "eres un p*** genio"],
    ["qué foto más de mierda jaja", "qué foto más de m***** jaja"],
    ["hijo de puta, qué disputa", "hijo de p***, qué disputa"],
    ["this is bullshit lol", "this is b******* lol"],
    ["shut up, b1tch!!", "shut up, b****!!"],
    ["la computadora es una p.u.t.a mierda", "la computadora es una p****** m*****"],
    ["What the FUCK, assistant?", "What the F***, assistant?"],
    ["puta😂", "p***😂"],
    ["(cabrón)", "(c*****)"],
  ]);

  describe("masks an emoji with a skin tone inside a word as one character", () => {
    expectMasks([
      ["p👍🏽u👍🏽t👍🏽a", "p******"],
      ["puta👍🏽", "p***👍🏽"],
    ]);
  });

  it("never changes the message length in characters as shown on screen", () => {
    const text = "Puta, p.u.t.a, PUUUTA, c0ño, ⓟⓤⓣⓐ, p👍🏽u👍🏽t👍🏽a y f u c k 😂";
    expect(graphemes(maskOffensiveWords(text))).toHaveLength(graphemes(text).length);
  });
});

describe("maskOffensiveWords: cost", () => {
  // Adversarial inputs at the chat's length limit: long runs of one letter, endless separators, many single letters
  // (every stretch of them is looked at), a near-miss word repeated, digits for leetspeak readings, symbols
  const worstCases = [
    "a".repeat(MAX_CHAT_LENGTH),
    "p".repeat(MAX_CHAT_LENGTH - 1) + "!",
    ". ".repeat(MAX_CHAT_LENGTH / 2),
    "a ".repeat(MAX_CHAT_LENGTH / 2),
    "a.".repeat(MAX_CHAT_LENGTH / 2),
    "p1".repeat(MAX_CHAT_LENGTH / 2),
    "1 ".repeat(MAX_CHAT_LENGTH / 2),
    "pu".repeat(MAX_CHAT_LENGTH / 2),
    "puta ".repeat(MAX_CHAT_LENGTH / 5),
    "😂".repeat(MAX_CHAT_LENGTH / 2),
    "ⓟ ".repeat(MAX_CHAT_LENGTH / 2),
  ];

  it("handles worst-case 100-character messages in well under a millisecond each", () => {
    for (const text of worstCases) expect(text.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
    const runs = 100;
    const start = performance.now();
    for (let i = 0; i < runs; i++) for (const text of worstCases) maskOffensiveWords(text);
    const perMessageMs = (performance.now() - start) / (runs * worstCases.length);
    expect(perMessageMs).toBeLessThan(1);
  });

  it("grows linearly with the message: 50× longer input stays fast (no catastrophic backtracking)", () => {
    const long = "p.".repeat(1_250) + "a ".repeat(1_250) + "puuu".repeat(625);
    const start = performance.now();
    maskOffensiveWords(long);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
