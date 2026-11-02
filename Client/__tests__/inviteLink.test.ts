import { LinkInput, linkStep } from "../app/utils/inviteLink";

// The waiting room's link decision (EXP-358, EXP-363, DEC-047), every mode against every kind of link.

const MINE = "ABC234";
const OTHER = "XYZ789";

type Case = [string, LinkInput, ReturnType<typeof linkStep>];
const CASES: Case[] = [
  // Just opened, not in a room
  ["cold invite link", { mode: "idle", linkedCode: OTHER, roomCode: null, roomScreenBelow: false }, { step: "ask", mode: "idle" }],
  ["link to another room while a typed code waits", { mode: "idle", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: false }, { step: "ask", mode: "idle" }],
  ["link to the typed code's room", { mode: "idle", linkedCode: MINE, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["link to another room over the game", { mode: "idle", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: true }, { step: "ask", mode: "overRoomScreen" }],
  ["link to the game's own room over the game", { mode: "idle", linkedCode: MINE, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  // EXP-363: pushed over the game, unlike Play again (which replaces it), whether its code is malformed or missing
  ["link without a valid code, or without any, over the game", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  ["Play again (the game screen replaced, its socket kept)", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["Search room (a typed code)", { mode: "idle", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "idle" }],
  ["Create game, or a cold link without a valid code", { mode: "idle", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "newRoomOrHome", mode: "idle" }],
  // In its lobby
  ["lobby: link to another room", { mode: "lobby", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: false }, { step: "ask", mode: "lobby" }],
  ["lobby: link to its own room", { mode: "lobby", linkedCode: MINE, roomCode: MINE, roomScreenBelow: false }, { step: "startLobby", mode: "lobby" }],
  ["lobby: link without a valid code, or cleared by Cancel", { mode: "lobby", linkedCode: null, roomCode: MINE, roomScreenBelow: false }, { step: "none", mode: "lobby" }],
  ["lobby still creating its room: link cleared", { mode: "lobby", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "none", mode: "lobby" }],
  // Over the room's screen, its dialog open
  ["over the game: another link", { mode: "overRoomScreen", linkedCode: "QWE567", roomCode: MINE, roomScreenBelow: true }, { step: "ask", mode: "overRoomScreen" }],
  ["over the game: link to the game's room", { mode: "overRoomScreen", linkedCode: MINE, roomCode: MINE, roomScreenBelow: true }, { step: "backToRoomScreen", mode: "overRoomScreen" }],
  ["over the game: link without a valid code", { mode: "overRoomScreen", linkedCode: null, roomCode: MINE, roomScreenBelow: true }, { step: "none", mode: "overRoomScreen" }],
  // Gone
  ["left: any link", { mode: "left", linkedCode: OTHER, roomCode: MINE, roomScreenBelow: true }, { step: "none", mode: "left" }],
  ["left: no link", { mode: "left", linkedCode: null, roomCode: null, roomScreenBelow: false }, { step: "none", mode: "left" }],
];

describe("linkStep (EXP-358, EXP-363)", () => {
  it.each(CASES)("%s", (_name, input, expected) => {
    expect(linkStep(input)).toEqual(expected);
  });
});
