import { LinkInput, linkStep } from "../app/utils/inviteLink";

// The waiting room's link decision (EXP-358, EXP-363, EXP-367, DEC-047), every mode against every kind of link.

const MINE = "ABC234";
const OTHER = "XYZ789";

/** A link input; `malformedLink` is false unless the case is about a link whose code is malformed */
type CaseInput = Omit<LinkInput, "malformedLink"> & Partial<Pick<LinkInput, "malformedLink">>;
type Case = [string, CaseInput, ReturnType<typeof linkStep>];
const CASES: Case[] = [
  // Just opened, not in a room
  ["cold invite link", { mode: "idle", linkedCode: OTHER, roomCode: null, roomScreenBelow: false }, { step: "ask", mode: "idle" }],
  ["link to another room while a typed code waits", { mode: "idle", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: false }, { step: "ask", mode: "idle" }],
  ["link to the typed code's room", { mode: "idle", linkedCode: MINE, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["link to another room over the game", { mode: "idle", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: true }, { step: "ask", mode: "overRoomScreen" }],
  ["link to the game's own room over the game", { mode: "idle", linkedCode: MINE, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  // EXP-363: pushed over the game, unlike Play again (which replaces it), whether its code is malformed or missing
  ["link without any code over the game", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  ["malformed link over the game", { mode: "idle", linkedCode: null, malformedLink: true, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  ["Play again (the game screen replaced, its socket kept)", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["Search room (a typed code)", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["Create game, or a cold link without a code", { mode: "idle", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "newRoomOrHome", mode: "idle" }],
  ["cold malformed link", { mode: "idle", linkedCode: null, malformedLink: true, roomCode: null, roomScreenBelow: false }, { step: "newRoomOrHome", mode: "idle" }],
  // EXP-367: a malformed code names no room, not even the one the app still knows
  ["malformed link while a room is known", { mode: "idle", linkedCode: null, malformedLink: true, roomCode: MINE, roomScreenBelow: false }, { step: "newRoomOrHome", mode: "idle" }],
  // In its lobby
  ["lobby: link to another room", { mode: "lobby", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: false }, { step: "ask", mode: "lobby" }],
  ["lobby: link to its own room", { mode: "lobby", linkedCode: MINE, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "lobby" }],
  ["lobby: link cleared by Cancel", { mode: "lobby", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "none", mode: "lobby" }],
  ["lobby: malformed link", { mode: "lobby", linkedCode: null, malformedLink: true, roomCode: MINE, roomScreenBelow: false }, { step: "none", mode: "lobby" }],
  ["lobby still creating its room: link cleared", { mode: "lobby", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "none", mode: "lobby" }],
  // Over the room's screen, its dialog open
  ["over the game: another link", { mode: "overRoomScreen", linkedCode: "QWE567", roomCode: MINE, roomScreenBelow: true }, { step: "ask", mode: "overRoomScreen" }],
  ["over the game: link to the game's room", { mode: "overRoomScreen", linkedCode: MINE, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  ["over the game: malformed link", { mode: "overRoomScreen", linkedCode: null, malformedLink: true, roomCode: MINE, roomScreenBelow: true }, { step: "none", mode: "overRoomScreen" }],
  // Gone
  ["left: any link", { mode: "left", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: true }, { step: "none", mode: "left" }],
  ["left: no link", { mode: "left", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "none", mode: "left" }],
];

describe("linkStep (EXP-358, EXP-363, EXP-367)", () => {
  it.each(CASES)("%s", (_name, input, expected) => {
    expect(linkStep({ malformedLink: false, ...input })).toEqual(expected);
  });
});
