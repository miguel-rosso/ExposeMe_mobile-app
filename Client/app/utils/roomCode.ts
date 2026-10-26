// Room codes: 6 characters from an uppercase alphanumeric alphabet without look-alikes (no 0/O, 1/I/L), the same
// alphabet the server draws them from (Server/managers/roomCode.ts).

export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const NOT_IN_ALPHABET_RE = new RegExp(`[^${ROOM_CODE_ALPHABET}]`, "g");
const ASCII_EDGE_SPACE_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const ASCII_LOWER_RE = /[a-z]/g;

/**
 * Uppercases ASCII a-z only, like the server: String#toUpperCase would turn other characters into code letters
 * ("ß" → "SS", "ſ" → "S"), so a non-ASCII character stays as it is and makes the code malformed.
 */
const asciiUpper = (text: string): string => text.replace(ASCII_LOWER_RE, (c) => c.toUpperCase());

/** Whether `code` is a complete, well-formed room code (it may still match no room). */
export const isRoomCode = (code: unknown): code is string => typeof code === "string" && ROOM_CODE_RE.test(code);

/**
 * What the join field holds after the player types or pastes `text`: uppercased, with anything no code can contain
 * (spaces, dashes, look-alikes, non-ASCII) dropped, and at most ROOM_CODE_LENGTH characters.
 */
export const sanitizeRoomCodeInput = (text: string): string =>
  asciiUpper(text).replace(NOT_IN_ALPHABET_RE, "").slice(0, ROOM_CODE_LENGTH);

/** Room code from the invite deep link's `code` parameter (any case, surrounding spaces), or null if malformed. */
export function parseRoomCodeParam(param: string | string[] | undefined): string | null {
  const raw = Array.isArray(param) ? param[0] : param;
  if (typeof raw !== "string") return null;
  const code = asciiUpper(raw.replace(ASCII_EDGE_SPACE_RE, ""));
  return isRoomCode(code) ? code : null;
}
