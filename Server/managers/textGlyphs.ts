/**
 * Glyph rules shared by player names (playerName.ts) and chat text (chatText.ts), as regex sources for `u` or `v` mode.
 */

/** A regex character class matching the [first, last] code point `ranges`. */
export const codePointClass = (ranges: ReadonlyArray<readonly [number, number]>) =>
  `[${ranges.map(([first, last]) => `\\u{${first.toString(16)}}-\\u{${last.toString(16)}}`).join("")}]`;

/**
 * Combining marks a letter may stack (EXP-447, EXP-454): real spellings stack up to four (Tibetan, pointed Hebrew); more
 * is "Zalgo" text. Only non-spacing and enclosing marks stack over or under a letter: spacing marks (Mc, e.g. the
 * Burmese vowel signs U+103B, U+1031 and U+102C) take room beside it like a letter, so they never count, nor end a pile.
 */
export const MAX_STACKED_MARKS = 4;
export const STACKING_MARK = "[\\p{Mn}\\p{Me}]";

/** More than MAX_STACKED_MARKS stacking marks on one letter: in a run of combining marks, spacing ones in between. */
export const MARK_PILE_SOURCE = `${STACKING_MARK}(?:\\p{Mc}*${STACKING_MARK}){${MAX_STACKED_MARKS}}`;

/**
 * Class contents of the visible-looking characters drawn blank: braille blank, object replacement, Khitan filler and
 * musical null notehead.
 */
export const BLANK_GLYPHS = "\\u2800\\uFFFC\\u{16FE4}\\u{1D159}";
