// The stack of rows at the bottom of the game photo, in dp above the safe area's bottom edge (see safeAreaRows).
// Shared by the emoji row, the game screen (answers, hold button) and the round scoreboard that keeps clear of them.

/** Emoji reaction row: its offset and height (h-10 buttons + py-1) */
export const EMOJI_ROW_BOTTOM = 48;
export const EMOJI_ROW_HEIGHT = 48;

/** The photo owner's hold button sits right on top of the emoji row; height: p-4 + border-2 + one text-lg line */
export const HOLD_BUTTON_BOTTOM = EMOJI_ROW_BOTTOM + EMOJI_ROW_HEIGHT;
export const HOLD_BUTTON_HEIGHT = 64;

/** The answer options row has p-2: its buttons line up with the hold button */
const ANSWERS_ROW_PADDING = 8;
export const ANSWERS_BOTTOM = HOLD_BUTTON_BOTTOM - ANSWERS_ROW_PADDING;

/**
 * The game's Exit button (EXP-377), bottom-left in the strip under the emoji row: nothing else is drawn there (the
 * answers, the hold button and the scoreboard's list all end above the emoji row), so it never covers an option or a
 * button. `side`: its distance from the left safe edge.
 */
export const LEAVE_BUTTON = { bottom: 6, height: 36, side: 12 } as const;
