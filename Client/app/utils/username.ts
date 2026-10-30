// The player's name as the app saves, sends and compares it (EXP-263). The server stores names exactly as received,
// so stray spaces typed on the home screen (iOS autocorrect adds a trailing one) would show to everyone.

const WHITESPACE_RUN_RE = /\s+/g;

/**
 * `name` without leading or trailing whitespace and with every run of whitespace inside (double spaces, tabs,
 * no-break spaces, which the server refuses) turned into one plain space: "  Ana  María " → "Ana María".
 * Empty when the name is blank.
 */
export const normalizeUsername = (name: string | null | undefined): string =>
  (name ?? "").replace(WHITESPACE_RUN_RE, " ").trim();

/** AsyncStorage key of the name typed on the home screen, kept for the next launch */
export const USERNAME_STORAGE_KEY = "username";
