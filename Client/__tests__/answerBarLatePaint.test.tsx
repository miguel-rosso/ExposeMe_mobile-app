import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { honourNativeAnimationDurations } from "../testUtils/nativeAnimations";
import { playerOptionId } from "../app/utils/testIds";

// EXP-300: the answer bar started when the answering phase was painted, not when round-start arrived. Androids paint it
// 0.3-2.5 s late, so the bar (the only cut-off for taps) ended after the server had frozen the answers: a late pick was
// highlighted but never counted. The bar now ends at the event's arrival + duration, however late the phase is painted,
// also for a resync snapshot (what is left of the phase, from when the snapshot arrived).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn(), resetUsedPhotos: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
// A slow phone: rendering a new round photo takes MOUNT_LAG_MS of device time, so the phase (and its bar, rendered
// after the photo) is painted that long after its event's handler ran
const MOUNT_LAG_MS = 700;
const mockRenderedPhotos = new Set<string>();
jest.mock("@/app/components/PhotoComponent", () => (p: { photoUrl: string }) => {
  if (!mockRenderedPhotos.has(p.photoUrl)) {
    mockRenderedPhotos.add(p.photoUrl);
    jest.setSystemTime(Date.now() + MOUNT_LAG_MS);
  }
  return null;
});
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const ANSWERING_MS = 7_700;
// A tap this long before the bar should end: more than the app's 200 ms between picks, so a later tap is sent at once
// (not coalesced into a trailing send) if answers are still open
const LAST_TAP_BEFORE_END_MS = 300;
// A tap this long after the bar should have ended, then long enough for any trailing send of it
const TAP_AFTER_END_MS = 50;
const TRAILING_SEND_MS = 500;

describe("GameScreen: the answer bar ends at the event's arrival + duration, however late it is painted (EXP-300)", () => {
  let r: TestRenderer.ReactTestRenderer;
  const tap = (name: string) => {
    const option = r.root.find((n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function");
    act(() => option.props.onPress());
  };
  const sentGuesses = () => mockSocket.emittedPayloads("submit-answer");
  // Device time from the event's arrival, whatever the paint added to it
  const advanceTo = (arrivedAt: number, ms: number) => act(() => jest.advanceTimersByTime(arrivedAt + ms - Date.now()));
  // Taps are taken until `duration` after the event arrived, and none after it (sent then or later)
  const expectAnswersCloseAt = (arrivedAt: number, duration: number) => {
    advanceTo(arrivedAt, duration - LAST_TAP_BEFORE_END_MS);
    tap("carol");
    expect(sentGuesses()).toEqual([{ guess: "carol" }]);

    // The server stops taking answers ANSWER_GRACE after this: a tap here would be highlighted and never count
    advanceTo(arrivedAt, duration + TAP_AFTER_END_MS);
    tap("alice");
    act(() => jest.advanceTimersByTime(TRAILING_SEND_MS));
    expect(sentGuesses()).toEqual([{ guess: "carol" }]);
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    honourNativeAnimationDurations();
    mockSocket.reset();
    mockRenderedPhotos.clear();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await act(async () => {}); // the room photo headers: the photo is only rendered with them
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("round-start: taps are taken until arrival + duration, not until paint + duration", () => {
    const arrivedAt = Date.now();
    act(() => mockSocket.fire("round-start", { photo: "/temp/a.jpg", round: 1, duration: ANSWERING_MS }));
    expect(Date.now()).toBe(arrivedAt + MOUNT_LAG_MS); // painted late
    expectAnswersCloseAt(arrivedAt, ANSWERING_MS);
  });

  it("game-state snapshot: what is left of answering runs from the snapshot's arrival", () => {
    const LEFT_MS = 4_000;
    const arrivedAt = Date.now();
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 1, totalRounds: 10, photo: "/temp/a.jpg", correctAnswer: null,
      yourGuess: null, duration: LEFT_MS, phaseTotal: ANSWERING_MS, held: false, pause: null, scores: [],
      players: mockPlayers,
    }));
    expect(Date.now()).toBe(arrivedAt + MOUNT_LAG_MS);
    expectAnswersCloseAt(arrivedAt, LEFT_MS);
  });
});
