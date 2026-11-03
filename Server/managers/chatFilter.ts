import { ASCII_CONFUSABLES } from "./asciiConfusables";

/**
 * Chat moderation (EXP-424): masks insults, slurs and explicit sexual words in es/en before a chat message is relayed,
 * keeping each word's first character and its length in characters as shown on screen (graphemes: "puta" → "p***").
 *
 * Matching is token-based (no regex over the whole message, so no backtracking blow-up) and only on whole words, so a
 * listed word inside an unrelated one is never touched ("computadora", "disputa", "assistant", "Scunthorpe"). A word
 * is compared after normalising it:
 * - case, accents and other diacritics ("PÚTA" → "puta"), compatibility forms ("ⓟⓤⓣⓐ", fullwidth letters), except ñ,
 *   which stays a letter of its own ("cono" ≠ "coño");
 * - letters of other scripts drawn like Latin ones (Cyrillic "р", Greek "ο", small capitals "ᴘ"), read as an extra
 *   reading of the word, so Latin text reads the same as without it;
 * - common leetspeak (0→o, 1→i or l, 3→e, 4→a, 5→s, @→a, $→s);
 * - stretched letters: a letter typed ELONGATED_RUN or more times in a row counts as that letter ("puuuta",
 *   "zorrrrra"); otherwise each letter must be doubled exactly as in the listed word ("zora" is not "zorra", "poor" is
 *   not "por");
 * - a plural -s, -es after the endings that take it, or -ies for a final -y ("putas", "maricones", "bitches",
 *   "pussies"; "spices" is not "spic");
 * - separators inside the word: punctuation within one chunk ("p.u.t.a", "f-u-c-k") or single letters spaced apart
 *   ("p u t a", also inside a longer run of them: "y p u t a").
 */

// ── Word list ──────────────────────────────────────

// Base forms written normally (accents allowed); plurals and the normalisations above are matched automatically, other
// inflections are listed. Keep it to words that are offensive in (almost) every use: words that are just as often
// harmless stay out ("perra" = female dog, "concha" = shell, "coger" = to take in Spain, "cock" = rooster, "polla" =
// betting pool in Chile and Peru, "kike" = the usual nickname for Enrique).
const SPANISH_WORDS = [
  // Insults
  "puta", "puto", "putita", "putito", "hijoputa", "hijueputa", "putamadre", "gilipollas", "cabrón", "cabrona",
  "pendejo", "pendeja", "mamón", "mamona", "malparido", "malparida", "culero", "culera", "imbécil", "subnormal",
  "zorra", "mierda", "bastardo", "bastarda",
  // Slurs
  "maricón", "marica", "joto", "bollera", "travelo", "sudaca", "negrata",
  // Explicit sexual terms
  "coño", "verga", "follar", "follando", "follada", "mamada", "chingar", "chingada", "chingado",
];

const ENGLISH_WORDS = [
  // Insults ("dick" also masks the name, as in Moby Dick: an accepted false positive)
  "fuck", "fucker", "fucking", "fucked", "motherfucker", "shit", "bullshit", "bitch", "bastard", "asshole", "dick",
  "dickhead", "cunt", "twat", "wanker", "whore", "slut", "retard", "retarded",
  // Slurs ("fag" also masks the British word for a cigarette: an accepted false positive)
  "faggot", "fag", "nigger", "nigga", "spic", "tranny",
  // Explicit sexual terms
  "pussy", "porn", "porno", "blowjob", "handjob", "jizz", "dildo", "wank",
];

export const BLOCKED_WORDS: readonly string[] = [...SPANISH_WORDS, ...ENGLISH_WORDS];

// ── Normalisation ──────────────────────────────────────

const LEET_LETTERS: Readonly<Record<string, string>> = { "0": "o", "3": "e", "4": "a", "5": "s", "@": "a", $: "s" };
// "1" stands for both i and l: a word is read once with each
const LEET_ONE_READINGS = ["i", "l"];

const COMBINING_MARKS = /\p{M}/gu;
// A character words are made of: a letter (with its marks), a digit or a leetspeak symbol, or a character whose
// compatibility form is a letter ("ⓟ" is a symbol, its form "p")
const WORD_CHAR = /^[\p{L}\p{M}\p{N}@$]$/u;
const HAS_LETTER = /\p{L}/u;
const CHUNKS = /\S+/g;
// A letter typed this many times in a row is a stretched one, whatever the word: doubled letters are not, as plenty of
// normal words have them ("poorness" would otherwise read "porn" + "es", "mammon" "mamón")
const ELONGATED_RUN = 3;

/** A plural ending, the endings of the singular it follows (empty: any) and the singular's ending it replaces. */
interface PluralEnding { ending: string; after: readonly string[]; replaces: string }
// -es only follows the endings that take it in Spanish or English ("maricones", "bitches"), never a vowel or most
// consonants ("spices" is not "spic" + "es"); English -ies stands for a final -y ("pussies" → "pussy")
const PLURAL_ENDINGS: readonly PluralEnding[] = [
  { ending: "s", after: [], replaces: "" },
  { ending: "es", after: ["ch", "sh", "s", "x", "z", "n", "l", "r", "d"], replaces: "" },
  { ending: "ies", after: [], replaces: "y" },
];

// Spanish ñ is a letter of its own, not an accented n ("cono" is a cone, "coño" is not)
const N_TILDE = "ñ";

/** `char` without accents or other marks, and compatibility forms folded ("é" → "e", "ⓟ" → "p"); ñ is kept. */
const withoutDiacritics = (char: string) =>
  char === N_TILDE ? char : char.normalize("NFKD").replace(COMBINING_MARKS, "");

/** `text` with letters of other scripts drawn like Latin ones read as those ("рuта" → "puta"). */
const asLatinLookalikes = (text: string) =>
  [...text].map((char) => ASCII_CONFUSABLES.get(char) ?? char).join("").toLowerCase();

/** `text` with leetspeak read as letters, "1" read as `one`. */
const asLetters = (text: string, one: string) =>
  text.replace(/[0345@$]/g, (ch) => LEET_LETTERS[ch]).replace(/1/g, one);

/**
 * The ways of reading `word`, always in the same order: lowercase and without diacritics (ñ kept), then also with
 * lookalikes read as Latin, each with leetspeak read as letters and "1" as i, then as l. The same order for every
 * word lets single letters be read one by one and joined (see blockedSpacedLetters).
 */
function readingVariants(word: string): string[] {
  const plain = [...word.toLowerCase().normalize("NFC")].map(withoutDiacritics).join("");
  return [plain, asLatinLookalikes(plain)].flatMap((form) => LEET_ONE_READINGS.map((one) => asLetters(form, one)));
}

/** One letter and how many times in a row it appears. */
interface LetterRun { letter: string; count: number }

/** `word` as runs of the same letter: "puuuta" → p×1 u×3 t×1 a×1. */
function letterRuns(word: string): LetterRun[] {
  const runs: LetterRun[] = [];
  for (const letter of word) {
    const last = runs[runs.length - 1];
    if (last?.letter === letter) last.count++;
    else runs.push({ letter, count: 1 });
  }
  return runs;
}

const lettersOf = (runs: LetterRun[]) => runs.map((run) => run.letter).join("");
/** `text` with repeated letters collapsed: "zorra" → "zora". */
const collapsed = (text: string) => lettersOf(letterRuns(text));

// Listed words by their letters with repeats collapsed ("zorra" → "zora"), each kept with its own repeat counts
const BLOCKED_BY_LETTERS = new Map<string, LetterRun[][]>();
for (const word of BLOCKED_WORDS) {
  for (const reading of new Set(readingVariants(word))) {
    const runs = letterRuns(reading);
    const key = lettersOf(runs);
    BLOCKED_BY_LETTERS.set(key, [...(BLOCKED_BY_LETTERS.get(key) ?? []), runs]);
  }
}

/** True when `runs` spells a listed word, each letter typed as many times as in that word or stretched. */
function spellsBlockedWord(runs: LetterRun[]): boolean {
  const listed = BLOCKED_BY_LETTERS.get(lettersOf(runs)) ?? [];
  const typedAsListed = (run: LetterRun, i: number) => runs[i].count === run.count || runs[i].count >= ELONGATED_RUN;
  return listed.some((word) => word.every(typedAsListed));
}

/** `runs` followed by the letters of `text`, each typed once. */
function withLetters(runs: LetterRun[], text: string): LetterRun[] {
  const joined = runs.map((run) => ({ ...run }));
  for (const letter of text) {
    const last = joined[joined.length - 1];
    if (last?.letter === letter) last.count++;
    else joined.push({ letter, count: 1 });
  }
  return joined;
}

/** `runs` as the singular of `plural` ("putas" → "puta", "pussies" → "pussy"); null unless they are that plural. */
function singularOf(runs: LetterRun[], { ending, after, replaces }: PluralEnding): LetterRun[] | null {
  if (runs.length <= ending.length || lettersOf(runs.slice(-ending.length)) !== ending) return null;
  const stem = runs.slice(0, -ending.length);
  const stemLetters = lettersOf(stem);
  if (after.length > 0 && !after.some((end) => stemLetters.endsWith(end))) return null;
  return withLetters(stem, replaces);
}

/** True when `reading` (one of readingVariants) is a listed word or its plural. */
function isBlockedReading(reading: string): boolean {
  const runs = letterRuns(reading);
  if (spellsBlockedWord(runs)) return true;
  return PLURAL_ENDINGS.some((plural) => {
    const singular = singularOf(runs, plural);
    return !!singular && spellsBlockedWord(singular);
  });
}

/** True when `word` (its characters as typed, separators left out) is a listed word or its plural. */
const isBlockedWord = (word: string) => [...new Set(readingVariants(word))].some(isBlockedReading);

// Collapsed letters of every listed word and its plurals, and every start of them: spaced single letters are read
// one at a time and given up on as soon as they can't become a listed word
const pluralForms = (key: string) => PLURAL_ENDINGS
  .filter(({ replaces }) => key.endsWith(replaces))
  .map(({ ending, replaces }) => collapsed(key.slice(0, key.length - replaces.length) + ending));
const BLOCKED_FORMS = new Set([...BLOCKED_BY_LETTERS.keys()].flatMap((key) => [key, ...pluralForms(key)]));
const BLOCKED_FORM_STARTS = new Set(
  [...BLOCKED_FORMS].flatMap((form) => [...form].map((_, i) => form.slice(0, i + 1))),
);

// Longest stretch of spaced single letters looked at as one word: the longest listed word with a plural ending
const MAX_SPACED_WORD_LETTERS = Math.max(...BLOCKED_WORDS.map((word) => [...word].length)) + 2;

// ── Words in the message ──────────────────────────────────────

/** A stretch of the message, [start, end) in UTF-16 units. */
interface Span { start: number; end: number; text: string }

const isWordChar = (char: string) => WORD_CHAR.test(char) || HAS_LETTER.test(char.normalize("NFKD"));

/** The message's words: maximal runs of word characters, in order. */
function wordSpans(message: string): Span[] {
  const spans: Span[] = [];
  let start = -1;
  let i = 0;
  const close = (end: number) => {
    if (start >= 0) spans.push({ start, end, text: message.slice(start, end) });
    start = -1;
  };
  for (const char of message) {
    if (!isWordChar(char)) close(i);
    else if (start < 0) start = i;
    i += char.length;
  }
  close(i);
  return spans;
}

/** One span from the first of `spans` to the last, its text only their word characters ("p.u.t.a" → "puta"). */
const joinSpans = (spans: Span[]): Span => ({
  start: spans[0].start,
  end: spans[spans.length - 1].end,
  text: spans.map((span) => span.text).join(""),
});

/** Whitespace-separated chunks made of several words joined by punctuation ("p.u.t.a", "f-u-c-k"), as one word. */
function punctuatedWords(message: string, words: Span[]): Span[] {
  const joined: Span[] = [];
  let next = 0; // words and chunks both run left to right: each word is looked at once
  for (const chunk of message.matchAll(CHUNKS)) {
    const chunkEnd = chunk.index + chunk[0].length;
    const inside: Span[] = [];
    for (; next < words.length && words[next].end <= chunkEnd; next++) inside.push(words[next]);
    if (inside.length > 1) joined.push(joinSpans(inside));
  }
  return joined;
}

/**
 * Consecutive one-letter words, whatever separates them ("p u t a"), that spell a listed word: any stretch of them, so
 * one next to other single letters is found too ("y p u t a").
 */
function blockedSpacedLetters(words: Span[]): Span[] {
  const groups: Span[][] = [[]];
  for (const word of words) {
    const isSingle = [...word.text].length === 1;
    if (isSingle) groups[groups.length - 1].push(word);
    else if (groups[groups.length - 1].length > 0) groups.push([]);
  }
  return groups.filter((group) => group.length > 1).flatMap(blockedStretches);
}

/**
 * The stretches of `letters` (two or more one-letter words in a row) that spell a listed word. Each letter is read
 * once and the readings joined, the same variant for all of them (see readingVariants; a variant reading every letter
 * like an earlier one is skipped); a stretch is given up on as soon as its letters start no listed word, and never
 * goes past MAX_SPACED_WORD_LETTERS.
 */
function blockedStretches(letters: Span[]): Span[] {
  const readings = letters.map((letter) => readingVariants(letter.text));
  const allVariants = [...readings[0].keys()];
  const readsAlike = (earlier: number, variant: number) =>
    readings.every((reading) => reading[earlier] === reading[variant]);
  const variants = allVariants.filter(
    (variant) => !allVariants.slice(0, variant).some((earlier) => readsAlike(earlier, variant)),
  );
  const found: Span[] = [];
  for (let first = 0; first < letters.length; first++) {
    const end = Math.min(letters.length, first + MAX_SPACED_WORD_LETTERS);
    for (const variant of variants) {
      let reading = "";
      let form = ""; // `reading`'s letters, repeats collapsed
      for (let last = first; last < end; last++) {
        reading += readings[last][variant];
        form = collapsed(form + readings[last][variant]);
        if (!BLOCKED_FORM_STARTS.has(form)) break;
        if (last > first && BLOCKED_FORMS.has(form) && isBlockedReading(reading)) {
          found.push(joinSpans(letters.slice(first, last + 1)));
        }
      }
    }
  }
  return found;
}

// ── Masking ──────────────────────────────────────

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `message` with every listed word (see the top of this file) masked: its first character kept and each other
 * character as shown on screen (grapheme: an emoji with its skin tone, a letter with its accent), separators inside it
 * included, replaced by one "*". Anything else is left exactly as it was sent.
 */
export function maskOffensiveWords(message: string): string {
  const words = wordSpans(message);
  const blocked = [
    ...[...words, ...punctuatedWords(message, words)].filter((span) => isBlockedWord(span.text)),
    ...blockedSpacedLetters(words),
  ];
  // UTF-16 offsets after the first character of a masked word; a grapheme starting at one of them is masked
  const hidden = new Set<number>();
  for (const { start, end } of blocked) for (let i = start + 1; i < end; i++) hidden.add(i);
  if (hidden.size === 0) return message;
  let masked = "";
  for (const { segment, index } of GRAPHEMES.segment(message)) masked += hidden.has(index) ? "*" : segment;
  return masked;
}
