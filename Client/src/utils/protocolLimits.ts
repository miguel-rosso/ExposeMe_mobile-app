// Limits the app shares with the server. Copies of the server's values must stay equal to them, and the app's own
// limits must never let through what the server refuses: qa/lab/tests/protocol-constants.test.sh checks both.

/** Round counts the host can pick in the lobby: the server's ROUND_OPTIONS (Server/managers/RoomManager.ts). */
export const ROUND_OPTIONS = [10, 15, 20];

/** Longest lobby chat message: the server's MAX_CHAT_LENGTH (Server/routes/socketRoutes.ts) drops longer ones. */
export const MAX_CHAT_LENGTH = 100;

/**
 * Longest name the home screen's input takes: equal to the server's MAX_USERNAME_LENGTH
 * (Server/managers/playerName.ts), which refuses longer names, so the input never cuts a name the server accepts
 * (DEC-043).
 */
export const MAX_USERNAME_INPUT_LENGTH = 15;

/**
 * Shortest time between two lobby chat messages from this device. The app's own limit: at least the server's
 * CHAT_MESSAGE_LIMIT window (Server/managers/socketGuards.ts), which silently drops faster messages.
 */
export const CHAT_COOLDOWN_MS = 1_000;
