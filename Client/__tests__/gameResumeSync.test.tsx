import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { GameStateSnapshot } from "../src/models/interfaces";
import { TEST_IDS, playerOptionId } from "../src/utils/testIds";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-080 / EXP-099: after a resume or a reconnect the round bar started empty with the remaining time, as if the
// phase had restarted (and devices showed it at different points). It now starts at the fraction already gone.
// EXP-081: socket.io buffered what the game screen emitted while offline and flushed it on reconnect, before the
// rejoin; the screen now only emits while connected and re-sends what matters from the rejoin snapshot.

// Icon fonts are not loadable under jest (the pause modal's mute chips, EXP-422)
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPlayers = [
  { username: "alice", points: 0, isHost: true, connected: true, lastAnswerCorrect: false, lastGuess: "" },
  { username: "bob", points: 0, isHost: false, connected: true, lastAnswerCorrect: false, lastGuess: "" },
];
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    setPlantedPhotoUri: jest.fn(),
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
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => (props: { duration: number; elapsed?: number }) => {
  const { View } = require("react-native");
  return <View testID="progress-bar" duration={props.duration} elapsed={props.elapsed} />;
});

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true, gameNumber: 1, phase: "answering", round: 3, totalRounds: 10, photo: "/temp/1-a.jpg", correctAnswer: null, yourGuess: null,
  duration: 4_000, phaseTotal: 8_000, held: false, holdsLeft: 3, pause: null, scores: [], players: mockPlayers, roundOptions: [], ...over,
});
const ROUND_START = { photo: "/temp/1-a.jpg", round: 3, duration: 8_000 };
const PAUSE = { duration: 300_000, waitingFor: ["alice"], pause: 1, maxPauses: 3 };

const bar = (root: ReactTestInstance) => {
  const [found] = root.findAll((n) => n.props.testID === "progress-bar" && typeof n.type === "string");
  return found ? { duration: found.props.duration, elapsed: found.props.elapsed } : null;
};

const mountGame = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  return r;
};
const goOffline = () => act(() => { mockSocket.connected = false; mockSocket.fire("disconnect", "transport close"); });

describe("GameScreen round bar after a resume or reconnect (EXP-080)", () => {
  beforeEach(() => { mockSocket.reset(); jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("a new phase starts its bar empty", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    expect(bar(r.root)).toEqual({ duration: 8_000, elapsed: 0 });
    act(() => r.unmount());
  });

  it("a resumed pause continues the bar from the fraction already gone", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    act(() => mockSocket.fire("game-paused", PAUSE));
    expect(bar(r.root)).toBeNull();
    act(() => mockSocket.fire("game-resumed", { phase: "answering", duration: 2_000, phaseTotal: 8_000 }));
    expect(bar(r.root)).toEqual({ duration: 2_000, elapsed: 0.75 });
    act(() => r.unmount());
  });

  it("a reconnect snapshot of the same phase continues the bar; one of the photo wait shows a fresh wait", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    goOffline();
    mockSocket.connected = true;
    act(() => mockSocket.fire("game-state", snapshot({ duration: 6_000 })));
    expect(bar(r.root)).toEqual({ duration: 6_000, elapsed: 0.25 });

    act(() => mockSocket.fire("waiting-photo", { round: 4, duration: 15_000, gameNumber: 1 }));
    act(() => mockSocket.fire("game-state", snapshot({ phase: "waiting-photo", photo: null, duration: 3_000, phaseTotal: 15_000 })));
    expect(r.root.findAll((n) => n.props.testID === TEST_IDS.gameWaitingPhoto).length).toBeGreaterThan(0);
    expect(bar(r.root)).toEqual({ duration: 3_000, elapsed: 0.8 });
    act(() => r.unmount());
  });

  // EXP-273: the phase changed while away (answering → scores); the snapshot's phaseTotal places the bar
  it("a reconnect snapshot of a phase not seen from its start places the bar with the server's phaseTotal", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    goOffline();
    mockSocket.connected = true;
    act(() => mockSocket.fire("game-state", snapshot({ phase: "scores", correctAnswer: "alice", duration: 1_000, phaseTotal: 5_000 })));
    expect(bar(r.root)).toEqual({ duration: 1_000, elapsed: 0.8 });
    act(() => r.unmount());
  });
});

describe("GameScreen emits nothing while offline (EXP-081)", () => {
  beforeEach(() => { mockSocket.reset(); jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  const tapOption = (r: TestRenderer.ReactTestRenderer, name: string) => act(() => r.root.find(
    (n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function",
  ).props.onPress());

  it("a pick made offline is not buffered: the rejoin snapshot sends it once", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    goOffline();
    mockSocket.emitted = [];
    tapOption(r, "alice");
    act(() => jest.advanceTimersByTime(1_000));
    expect(mockSocket.emittedPayloads("submit-answer")).toEqual([]);

    mockSocket.connected = true;
    act(() => mockSocket.fire("game-state", snapshot()));
    expect(mockSocket.emittedPayloads("submit-answer")).toEqual([{ guess: "alice" }]);
    act(() => r.unmount());
  });

  it("the photo owner's hold pressed offline is not buffered", async () => {
    const r = await mountGame();
    act(() => mockSocket.fire("round-start", ROUND_START));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 2_000, yourGuess: "" }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 3, totalRounds: 10, duration: 6_000 }));
    goOffline();
    mockSocket.emitted = [];
    const hold = r.root.find((n) => n.props.testID === TEST_IDS.holdButton && typeof n.props.onPressIn === "function");
    act(() => hold.props.onPressIn());
    act(() => hold.props.onPressOut());
    expect(mockSocket.emitted.map(([ev]) => ev)).toEqual([]);
    act(() => r.unmount());
  });

  it("im-ready is not buffered when the screen opens offline: the rejoin snapshot of the ready phase sends it", async () => {
    mockSocket.connected = false;
    const r = await mountGame();
    expect(mockSocket.emittedPayloads("im-ready")).toEqual([]);
    mockSocket.connected = true;
    act(() => mockSocket.fire("game-state", snapshot({ phase: null, photo: null })));
    expect(mockSocket.emitted.filter(([ev]) => ev === "im-ready")).toEqual([["im-ready"]]); // no payload (EXP-332)
    act(() => r.unmount());
  });
});
