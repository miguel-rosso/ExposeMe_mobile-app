import fs from "fs";
import path from "path";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
import {
  KICKED_BY_HOST_MESSAGE, KNOWN_SERVER_MESSAGES, serverMessageKey, translateServerMessage, UNKNOWN_LINK_MESSAGE,
  UNKNOWN_SERVER_MESSAGE_KEY,
} from "../src/utils/serverMessage";

// EXP-180 / EXP-036: server error texts (room-of-game refusals, connect_error) are shown in the user's language,
// and anything unknown falls back to a generic localized message instead of raw English.

describe("serverMessageKey", () => {
  it.each([
    ["Too many attempts", "serverErrorTooManyAttempts"],
    ["Too many connections", "serverErrorTooManyConnections"],
    ["Invalid username", "serverErrorInvalidUsername"],
    ["Game not found", "serverErrorGameNotFound"],
    ["Game already started", "serverErrorGameAlreadyStarted"],
    ["Username already taken", "serverErrorUsernameTaken"],
    ["Username too similar", "serverErrorUsernameTooSimilar"],
    ["Room is full", "serverErrorRoomFull"],
    ["Server is busy", "serverErrorServerBusy"],
    [KICKED_BY_HOST_MESSAGE, "kickedByHost"],
    [UNKNOWN_LINK_MESSAGE, "unknownLinkNotice"],
  ])("maps %p to %p", (message, key) => {
    expect(serverMessageKey(message)).toBe(key);
  });

  it.each(["Something new from the server", "", "too many attempts", "constructor", "toString"])(
    "falls back to the generic message for unknown text %p",
    (message) => {
      expect(serverMessageKey(message)).toBe(UNKNOWN_SERVER_MESSAGE_KEY);
    },
  );
});

describe("translateServerMessage", () => {
  it("returns the Spanish text for Spanish translations", () => {
    expect(translateServerMessage("Too many attempts", es)).toBe(es.serverErrorTooManyAttempts);
    expect(translateServerMessage("Too many connections", es)).toBe(es.serverErrorTooManyConnections);
  });

  it("tells a name that is too similar apart from a taken one (EXP-032)", () => {
    expect(translateServerMessage("Username too similar", es)).toBe(
      "Ese nombre se parece demasiado al de otro jugador. Elige otro.",
    );
    expect(translateServerMessage("Username too similar", en)).toBe(
      "That name looks too much like another player's. Choose another one.",
    );
    expect(translateServerMessage("Username too similar", es)).not.toBe(es.serverErrorUsernameTaken);
  });

  it("never returns the raw server text for unknown messages", () => {
    expect(translateServerMessage("Brand new error", es)).toBe(es.serverErrorUnknown);
    expect(translateServerMessage("Brand new error", en)).toBe(en.serverErrorUnknown);
  });

  it("every Spanish server error text differs from the raw English protocol text", () => {
    ["Too many attempts", "Too many connections", "Game not found", "Room is full"].forEach((message) => {
      expect(translateServerMessage(message, es)).not.toBe(message);
    });
  });
});

// ── Parity with the server ──
// A new or renamed server refusal text must get its own translation here, or Spanish users see the generic one.

const SERVER_DIR = path.join(__dirname, "../../Server");
const SERVER_MESSAGE_SOURCES = ["routes/socketRoutes.ts", "managers/RoomManager.ts"];
/** `message: "..."` in room-of-game refusals and `next(new Error("..."))` in the connection middleware */
const SERVER_MESSAGE_PATTERNS = [/\bmessage:\s*"([^"]+)"/g, /next\(new Error\("([^"]+)"\)\)/g];

const serverMessageLiterals = (): string[] => {
  const literals = SERVER_MESSAGE_SOURCES.flatMap((file) => {
    const source = fs.readFileSync(path.join(SERVER_DIR, file), "utf8");
    return SERVER_MESSAGE_PATTERNS.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
  });
  return [...new Set(literals)];
};

describe("server message parity", () => {
  it("maps every error text the server can send to the lobby or home screen", () => {
    const literals = serverMessageLiterals();
    // Guard against the patterns silently matching nothing after a server refactor
    expect(literals).toEqual(expect.arrayContaining(["Game not found", "Too many connections"]));
    expect(literals.filter((m) => !KNOWN_SERVER_MESSAGES.includes(m))).toEqual([]);
  });
});
