import { UNASSIGNED_EMOJI_RANGES } from "./asciiConfusables";
import { JOINER_SCRIPTS, VIRAMA } from "./playerName";
import { BLANK_GLYPHS, codePointClass, MAX_STACKED_MARKS, STACKING_MARK } from "./textGlyphs";

/**
 * Lobby chat text (EXP-447): what the server relays in chat-message, keeps in the room's chat log and lets players
 * report. Words and letters are never touched (no word filter, DEC-060: each player mutes or reports); only characters
 * that break the bubble's layout or hide or reorder the text are normalised, so every player (the sender too, through
 * the ack) and a report's reviewer see the same visible text:
 * - control characters go, but line breaks (any kind becomes "\n") and tabs (a space);
 * - invisible characters go: zero-width spaces, word joiners, BOM, soft hyphens, fillers, bidi overrides and isolates
 *   (U+202A–202E, U+2066–2069) and tag characters outside a subdivision flag. Kept, as they shape what is seen:
 *   variation selectors (emoji presentation, CJK variants), the Mongolian vowel separator, the bidi marks LRM, RLM and
 *   ALM (which never override a letter's direction), the tags of the subdivision flags (England, Scotland, Wales) and
 *   one zero-width joiner or non-joiner where it shapes a script or an emoji (see shapingJoinersOnly);
 * - a letter keeps at most MAX_STACKED_MARKS stacking marks (Zalgo text; spacing marks, as in Burmese, don't count);
 * - blank lines and spaces ending a line go, and at most MAX_CHAT_LINE_BREAKS line breaks are kept, the rest become
 *   spaces (a line's indentation stays, for ASCII art);
 * - a message with nothing to see once normalised is no message (null).
 */

/** Line breaks one message keeps (so at most four lines, as many as the app's chat bubble shows) */
export const MAX_CHAT_LINE_BREAKS = 3;

// ── Characters ──────────────────────────────────────

const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;
const TAB = /\t/g;
// Controls (but "\n") and lone surrogates, which are no character at all
const CONTROL = /(?!\n)[\p{Cc}\p{Cs}]/gu;
// The subdivision flags of the emoji list (RGI): black flag + the tags "gbeng", "gbsct" or "gbwls" + cancel tag. Any
// other tag sequence draws as a plain black flag, its tags only hidden text
const SUBDIVISION_FLAG = "\\u{1F3F4}\\u{E0067}\\u{E0062}(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}";
const JOINERS = "\\p{Join_Control}";
// The bidi marks and the Mongolian vowel separator: invisible, but they shape the text around them
const DIRECTION_MARKS = "\\u200E\\u200F\\u061C\\u180E";
// Default-ignorable characters drawn as nothing, but those that shape the visible text (see the module comment)
const INVISIBLE = `[\\p{Default_Ignorable_Code_Point}--[${JOINERS}\\p{Variation_Selector}${DIRECTION_MARKS}]]`;
// Matches a whole subdivision flag (kept, in group 1) or one invisible character (dropped)
const FLAG_OR_INVISIBLE = new RegExp(`(${SUBDIVISION_FLAG})|${INVISIBLE}`, "gv");
// A run of combining marks, with the joiners and direction marks between them (which never end a pile)
const MARK_RUN = new RegExp(`\\p{M}[\\p{M}${JOINERS}${DIRECTION_MARKS}]*`, "gu");
const IS_STACKING_MARK = new RegExp(`^${STACKING_MARK}$`, "u");
const IS_SPACING_MARK = /^\p{Mc}$/u;
// Unassigned code points the running Node doesn't know, but those Unicode reserves for emoji (a newer emoji is seen)
const UNASSIGNED = `[\\p{Cn}--${codePointClass(UNASSIGNED_EMOJI_RANGES)}]`;
// A character that draws something: not a space, mark, format character, private-use, unassigned or blank one
const HAS_VISIBLE = new RegExp(
  `[^\\s\\p{M}\\p{Cf}\\p{Co}\\p{Default_Ignorable_Code_Point}${BLANK_GLYPHS}${UNASSIGNED}]`,
  "v",
);
// Joiners, and what they may sit between (see shapingJoinersOnly)
const IS_JOINER = new RegExp(`^${JOINERS}$`, "u");
const ZWJ = "\u200D";
const IS_JOINING_LETTER = new RegExp(
  `^[\\p{L}&&[${JOINER_SCRIPTS.map((name) => `\\p{Script_Extensions=${name}}`).join("")}]]$`,
  "v",
);
const IS_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const IS_EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const IS_VIRAMA = new RegExp(`^${VIRAMA}$`, "u");
const IS_MARK = /^\p{M}$/u;
// Spaces ending a line, its line break and any blank lines after it, up to the next line's indentation
const LINE_BREAK_RUN = /[^\S\n]*\n(?:\s*\n)?/g;

// ── Normalising ─────────────────────────────────────

const withoutControls = (text: string) => text.replace(LINE_BREAK, "\n").replace(TAB, " ").replace(CONTROL, "");

const withoutInvisibles = (text: string) =>
  text.replace(FLAG_OR_INVISIBLE, (_match, flag: string | undefined) => flag ?? "");

/** `run` (a MARK_RUN) with its stacking marks past the MAX_STACKED_MARKS-th dropped, and all but spacing marks after. */
function cappedMarkRun(run: string): string {
  let stacked = 0;
  return [...run].filter((char) => {
    if (IS_STACKING_MARK.test(char)) stacked++;
    return stacked <= MAX_STACKED_MARKS || IS_SPACING_MARK.test(char);
  }).join("");
}

/** What a joiner may follow: the last base character before it, and whether a virama sits between them. */
interface JoinerContext {
  base: "joining-letter" | "emoji" | "other";
  afterVirama: boolean;
}

const baseKind = (char: string): JoinerContext["base"] =>
  IS_JOINING_LETTER.test(char) ? "joining-letter" : IS_PICTOGRAPHIC.test(char) ? "emoji" : "other";

/**
 * Whether `joiner` shapes something in `context`, before `next` (undefined at the end), as for player names
 * (playerName.ts): between two letters of a script that spells with joiners (the Persian half-space, an Indic
 * conjunct), after a virama on such a letter (an Indic half form, a Malayalam chillu ending a word), or a zero-width
 * joiner between two emoji (a family, a rainbow flag).
 */
function shapes(joiner: string, { base, afterVirama }: JoinerContext, next: string | undefined): boolean {
  if (base === "joining-letter") return afterVirama || (next !== undefined && IS_JOINING_LETTER.test(next));
  return base === "emoji" && joiner === ZWJ && next !== undefined && IS_PICTOGRAPHIC.test(next);
}

/**
 * `text` with the first joiner of each run of joiners kept where it shapes something (see shapes), every other one
 * dropped (no hidden text in joiners). One pass over the code points.
 */
function shapingJoinersOnly(text: string): string {
  const chars = Array.from(text);
  const kept: string[] = [];
  const context: JoinerContext = { base: "other", afterVirama: false };
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (IS_JOINER.test(char)) {
      let last = i;
      while (last + 1 < chars.length && IS_JOINER.test(chars[last + 1])) last++;
      if (shapes(char, context, chars[last + 1])) kept.push(char);
      i = last;
      continue;
    }
    if (IS_MARK.test(char)) context.afterVirama = IS_VIRAMA.test(char);
    else if (!IS_EMOJI_MODIFIER.test(char)) { // a skin tone stays part of its emoji
      context.base = baseKind(char);
      context.afterVirama = false;
    }
    kept.push(char);
  }
  return kept.join("");
}

/** `text` (trimmed) with no blank lines and its line breaks past MAX_CHAT_LINE_BREAKS turned into spaces. */
function withCappedLineBreaks(text: string): string {
  let breaks = 0;
  return text.replace(LINE_BREAK_RUN, () => (++breaks <= MAX_CHAT_LINE_BREAKS ? "\n" : " "));
}

/** `text` as the room gets it (see the module comment), or null when nothing of it would be seen. */
export function normalizeChatText(text: string): string | null {
  const cleaned = shapingJoinersOnly(withoutInvisibles(withoutControls(text)).replace(MARK_RUN, cappedMarkRun)).trim();
  const normalized = withCappedLineBreaks(cleaned);
  return HAS_VISIBLE.test(normalized) ? normalized : null;
}
