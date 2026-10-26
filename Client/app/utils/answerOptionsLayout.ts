// Layout of the answer options drawn over the photo (EXP-250). With up to 12 players, 2 columns of regular cards
// would grow over most of the photo and the round timer, so the options get denser as the room grows and their area
// is capped to a share of the window: past that, the list scrolls inside it.

/** Share of the window height the options may take (the photo and the timer bar keep the rest) */
export const ANSWERS_MAX_HEIGHT_RATIO = 0.4;
/** From this many players the cards drop to the compact size */
export const COMPACT_FROM_PLAYERS = 7;
/** From this many players the options are laid out in 3 columns (names are cut with an ellipsis) */
export const THREE_COLUMNS_FROM_PLAYERS = 9;
/** Minimum height of a pressable option (Apple HIG / Material touch target) */
export const MIN_TOUCH_TARGET = 44;

export type AnswerOptionsLayout = {
  columns: 2 | 3;
  compact: boolean;
  /** Max height of the options list, in dp; taller content scrolls */
  maxHeight: number;
};

export const answerOptionsLayout = (playerCount: number, windowHeight: number): AnswerOptionsLayout => ({
  columns: playerCount >= THREE_COLUMNS_FROM_PLAYERS ? 3 : 2,
  compact: playerCount >= COMPACT_FROM_PLAYERS,
  maxHeight: Math.round(windowHeight * ANSWERS_MAX_HEIGHT_RATIO),
});
