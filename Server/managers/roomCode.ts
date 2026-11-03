import { randomInt } from "crypto";

// Room codes: 6 characters from an uppercase alphanumeric alphabet without look-alikes (no 0/O, 1/I/L), so they
// read and type unambiguously: 31^6 ≈ 8.9e8 codes. The app (Client/src/utils/roomCode.ts) uses the same alphabet.

export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ROOM_CODE_LENGTH = 6;

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** A fresh random code drawn with the CSPRNG (never predictable from earlier codes). */
export function randomRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

const ASCII_EDGE_SPACE_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const ASCII_LOWER_RE = /[a-z]/g;

/**
 * Canonical form of a typed or linked code: surrounding ASCII spaces dropped, ASCII a-z uppercased. ASCII only:
 * String#toUpperCase would map other characters onto code letters ("ß" → "SS", "ſ" → "S"), creating aliases; any
 * non-ASCII character is kept as is, so the result is malformed.
 */
export const normalizeRoomCode = (code: string): string =>
  code.replace(ASCII_EDGE_SPACE_RE, "").replace(ASCII_LOWER_RE, (c) => c.toUpperCase());

/** Whether `code` is a well-formed canonical room code (it may still match no room). */
export const isRoomCode = (code: unknown): code is string => typeof code === "string" && ROOM_CODE_RE.test(code);
