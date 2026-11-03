import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { KICKED_BY_HOST_MESSAGE } from "../src/utils/serverMessage";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-337: on the final screens (between games) the host can remove me from the lobby. The game screen used to only
// drop me from its list and then go home with no reason when the server closed the socket, keeping my rejoin token.
// Like the lobby (EXP-045), it now forgets the token and goes home telling me the host removed me; so does a rejoin the
// server refuses because I was kicked while offline.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockDismissTo = jest.fn();
const mockClearRejoinToken = jest.fn();
const mockSetHomeNotice = jest.fn();
const mockPlayers = ["alice", "bob"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: mockDismissTo }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    clearRejoinToken: mockClearRejoinToken, setPlantedPhotoUri: jest.fn(), setHomeNotice: mockSetHomeNotice,
    markRoomExit: jest.fn(),
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

// EXP-425: the host can remove me during the game too: the same notice, token forgotten, home once
describe("GameScreen: the host removes me during the game (EXP-425)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    mockSocket.reset();
    [mockDismissTo, mockClearRejoinToken, mockSetHomeNotice].forEach((m) => m.mockClear());
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("round-start", { round: 1, photo: "/temp/p.jpg", duration: 7_700 }));
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("my own player-removed mid-round forgets my token and goes home once with the notice", () => {
    act(() => mockSocket.fire("player-removed", mockPlayers[1]));
    act(() => mockSocket.fire("disconnect", "io server disconnect"));

    expect(mockClearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockSetHomeNotice).toHaveBeenCalledWith(KICKED_BY_HOST_MESSAGE);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    // Nothing goes to the room on the way out: the server already took me out
    expect(mockSocket.emittedPayloads("leave-room")).toEqual([]);
  });
});

const FINAL_SCORE = mockPlayers.map(({ username, points, isHost }) => ({ username, points, isHost, lastAnswerCorrect: false, lastGuess: "" }));

describe("GameScreen: the host removes me (EXP-337)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    mockSocket.reset();
    mockDismissTo.mockClear();
    mockClearRejoinToken.mockClear();
    mockSetHomeNotice.mockClear();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("game-over", { finalScore: FINAL_SCORE })); // on the final screens, between games
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("my own player-removed forgets my token and goes home once, telling why (the socket close after it is ignored)", () => {
    act(() => mockSocket.fire("player-removed", mockPlayers[1]));
    act(() => mockSocket.fire("disconnect", "io server disconnect"));

    expect(mockClearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    expect(mockSetHomeNotice).toHaveBeenCalledWith(KICKED_BY_HOST_MESSAGE);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
  });

  it("someone else's player-removed keeps me here", () => {
    act(() => mockSocket.fire("player-removed", mockPlayers[0]));

    expect(mockClearRejoinToken).not.toHaveBeenCalled();
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("kicked while offline: the refused rejoin forgets my token and goes home telling why", () => {
    act(() => mockSocket.fire("room-of-game", { success: false, message: KICKED_BY_HOST_MESSAGE }));

    expect(mockClearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockSetHomeNotice).toHaveBeenCalledWith(KICKED_BY_HOST_MESSAGE);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
  });

  it("another refusal goes home with its reason and keeps the token", () => {
    act(() => mockSocket.fire("room-of-game", { success: false, message: "Game not found" }));

    expect(mockClearRejoinToken).not.toHaveBeenCalled();
    expect(mockSetHomeNotice).toHaveBeenCalledWith("Game not found");
    expect(mockDismissTo).toHaveBeenCalledWith("/");
  });
});
