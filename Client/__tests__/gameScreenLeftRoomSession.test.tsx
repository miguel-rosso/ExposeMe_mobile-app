import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-342: leaving the game (Exit on the final screens, removed, room gone) forgets the room in GameContext while the
// game screen is still mounted for its exit transition. With no room there is no session to load room photos with:
// the screen must not warn about a missing session token then.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
let mockGameCode: string | null = "123456";
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: mockGameCode, socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

let warn!: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const sessionWarnings = () =>
  warn.mock.calls.filter(([message]) => String(message).includes("no session token"));

describe("GameScreen after the room is forgotten (EXP-342)", () => {
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("does not warn about a missing session token", async () => {
    jest.useFakeTimers();
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await flush();

    mockGameCode = null; // left: GameContext forgot the room, the screen is still on its way out
    await act(async () => { r.update(<GameScreen />); });
    await flush();

    expect(sessionWarnings()).toHaveLength(0);
    act(() => r.unmount());
  });
});
