import en from "../i18n/en";

type TranslationKey = keyof typeof en;

/**
 * Reason the lobby passes home when the host removed us: the server only sends `player-removed` (no text), so this
 * one is the client's own, shown through the same home-screen message as the server's refusals.
 */
export const KICKED_BY_HOST_MESSAGE = "Removed by host";

/**
 * Exact error texts the server can send to a client that ends up on the home screen: `room-of-game` refusals
 * (socketRoutes / RoomManager) and the socket middleware's `connect_error`. The protocol stays plain English;
 * the client maps it to its own language here. Also holds the client's own KICKED_BY_HOST_MESSAGE.
 */
const SERVER_MESSAGE_KEYS = {
  "Too many attempts": "serverErrorTooManyAttempts",
  "Too many connections": "serverErrorTooManyConnections",
  "Invalid username": "serverErrorInvalidUsername",
  "Game not found": "serverErrorGameNotFound",
  "Game already started": "serverErrorGameAlreadyStarted",
  "Username already taken": "serverErrorUsernameTaken",
  "Room is full": "serverErrorRoomFull",
  "Server is busy": "serverErrorServerBusy",
  [KICKED_BY_HOST_MESSAGE]: "kickedByHost",
} as const satisfies Record<string, TranslationKey>;

/** Every server text with its own translation (a parity test checks the server sends no others). */
export const KNOWN_SERVER_MESSAGES = Object.keys(SERVER_MESSAGE_KEYS);

/** Shown for any server text we don't know, so raw English never reaches the user. */
export const UNKNOWN_SERVER_MESSAGE_KEY = "serverErrorUnknown" satisfies TranslationKey;

export type ServerMessageKey =
  | (typeof SERVER_MESSAGE_KEYS)[keyof typeof SERVER_MESSAGE_KEYS]
  | typeof UNKNOWN_SERVER_MESSAGE_KEY;

export const serverMessageKey = (message: string): ServerMessageKey =>
  Object.prototype.hasOwnProperty.call(SERVER_MESSAGE_KEYS, message)
    ? SERVER_MESSAGE_KEYS[message as keyof typeof SERVER_MESSAGE_KEYS]
    : UNKNOWN_SERVER_MESSAGE_KEY;

/** Localized text for a server error message, using the current language's translations. */
export const translateServerMessage = (message: string, t: Record<ServerMessageKey, string>): string =>
  t[serverMessageKey(message)];
