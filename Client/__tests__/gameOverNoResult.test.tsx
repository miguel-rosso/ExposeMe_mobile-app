import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { AppState } from "react-native";
import GameScreen from "../app/screens/GameScreen";

// EXP-341 (DEC-044 A): a game that ends with nobody having scored (no rounds played, e.g. everyone else left during
// "Ready?", or everyone at 0) has no winner. The winner screen with its confetti is skipped and the final table is
// shown at once. It reaches the screen through game-over, or through the not-started snapshot that answers my
// im-ready when the game already ended (050c32a). A game with a winner, or a tie, still celebrates first.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockWinnerProps: { visible?: boolean; winners?: unknown[] }[] = [];
const mockFinalProps: { visible?: boolean; finalScore?: unknown[] }[] = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    setPlantedPhotoUri: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    pickGamePhoto: jest.fn(), setPhotoUri: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => (props: { visible?: boolean }) => { mockFinalProps.push(props); return null; });
jest.mock("@/app/components/modals/WinnerModal", () => (props: { visible?: boolean }) => { mockWinnerProps.push(props); return null; });
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  mockWinnerProps.length = 0;
  mockFinalProps.length = 0;
  mockSocket.emitted = [];
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const last = <T,>(list: T[]) => list[list.length - 1];
const endedSnapshot = (scores: unknown[]) => ({
  started: false, phase: null, round: 0, totalRounds: 10, photo: null, correctAnswer: null, yourGuess: null,
  duration: 0, phaseTotal: 0, held: false, pause: null, scores, players: [], roundOptions: [],
});

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();
  return r;
}

describe("GameScreen final screens when nobody scored (EXP-341)", () => {
  it("game-over with everyone at 0 skips the winner screen and shows the final table at once", async () => {
    const r = await mount();
    const finalScore = [{ username: "bob", points: 0 }, { username: "ana", points: 0 }];
    act(() => mockSocket.fire("game-over", { finalScore }));
    await flush();
    expect(last(mockWinnerProps).visible).toBe(false);
    expect(last(mockFinalProps)).toMatchObject({ visible: true, finalScore });
    act(() => r.unmount());
  });

  it("the not-started snapshot answering im-ready after the game ended (only me left, 0 points) does the same", async () => {
    const r = await mount();
    act(() => mockSocket.fire("game-state", endedSnapshot([{ username: "bob", points: 0 }])));
    await flush();
    expect(last(mockWinnerProps).visible).toBe(false);
    expect(last(mockFinalProps)).toMatchObject({ visible: true, finalScore: [{ username: "bob", points: 0 }] });
    act(() => r.unmount());
  });

  it("a game with a winner, or a tie, still shows the winner screen first", async () => {
    const cases = [
      { finalScore: [{ username: "bob", points: 3 }, { username: "ana", points: 0 }], winners: 1 },
      { finalScore: [{ username: "bob", points: 2 }, { username: "ana", points: 2 }], winners: 2 },
    ];
    for (const { finalScore, winners } of cases) {
      mockWinnerProps.length = 0;
      mockFinalProps.length = 0;
      const r = await mount();
      act(() => mockSocket.fire("game-over", { finalScore }));
      await flush();
      expect(last(mockWinnerProps).visible).toBe(true);
      expect(last(mockWinnerProps).winners).toHaveLength(winners);
      expect(last(mockFinalProps).visible).toBe(false);
      act(() => r.unmount());
    }
  });
});
