import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-162: no gallery photo is sent twice in one game. The photo memory lives in PhotoContext; the game screen
// (one per game, reconnects stay on it) clears it when it opens, so the next game starts fresh.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockResetUsedPhotos = jest.fn();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn(), resetUsedPhotos: mockResetUsedPhotos }),
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => (p: { visible: boolean; correctAnswer: string }) => {
  const { Text } = require("react-native");
  return p.visible ? <Text testID="score-correct-answer">{p.correctAnswer}</Text> : null;
});
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
const mockBar: { onEnd?: () => void } = {};
jest.mock("@/src/components/ProgressBar", () => (p: { onEnd?: () => void }) => { mockBar.onEnd = p.onEnd; return null; });

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe("GameScreen: photo memory per game (EXP-162)", () => {
  beforeEach(() => mockResetUsedPhotos.mockClear());

  it("clears the used photos once when the game screen opens, not on later rounds or a rejoin snapshot", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    expect(mockResetUsedPhotos).toHaveBeenCalledTimes(1);

    act(() => mockSocket.fire("round-start", { photo: "/temp/a.jpg", round: 1, duration: 8_000 }));
    act(() => mockSocket.fire("round-start", { photo: "/temp/b.jpg", round: 2, duration: 8_000 }));
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 2, totalRounds: 10, photo: "/temp/b.jpg",
      correctAnswer: null, duration: 5_000, held: false, pause: null, scores: [], players: mockPlayers, roundOptions: mockPlayers,
    }));
    await act(async () => { r.update(<GameScreen />); });
    expect(mockResetUsedPhotos).toHaveBeenCalledTimes(1);
    act(() => r.unmount());

    // Next game: a fresh game screen
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    expect(mockResetUsedPhotos).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
  });
});
