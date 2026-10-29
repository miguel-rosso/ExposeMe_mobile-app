import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { playerOptionId } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-042: a player who leaves (player-left) or is kicked (player-removed) mid-game stops being an answer option;
// new-host moves the host flag. A player merely disconnected (still in the room) stays an option (DEC-016).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
// Stateful players list, like GameContext's useState (functional updates included)
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider, setPlayersProvider, roundsOfGame: 10, plantedPhotoUri: null,
      plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    };
  },
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

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const optionNames = (root: ReactTestInstance) =>
  root
    .findAll((n) => typeof n.type === "string" && typeof n.props.testID === "string" && n.props.testID.startsWith("player-option-"))
    .map((n) => n.props.testID.replace("player-option-", ""));
// The players behind the answer options (the options grid's players), with their host flag
const optionPlayers = (root: ReactTestInstance) =>
  root.findAll((n) => Array.isArray(n.props.players) && typeof n.props.renderOption === "function")[0]
    .props.players.map((p: { username: string; isHost: boolean }) => [p.username, p.isHost]);
const press = (root: ReactTestInstance, name: string) =>
  act(() => root.find((n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function").props.onPress());
const START = { photo: "/temp/x.jpg", round: 1, duration: 8_000 };

describe("GameScreen: players leaving mid-game (EXP-042)", () => {
  let r: TestRenderer.ReactTestRenderer;
  let mounted: boolean;
  beforeEach(async () => {
    jest.useFakeTimers();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    mounted = true;
    act(() => mockSocket.fire("round-start", START));
    mockSocket.emitted = [];
  });
  afterEach(() => {
    if (mounted) act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("removes a player who left from the answer options", () => {
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    act(() => mockSocket.fire("player-left", "carol"));
    expect(optionNames(r.root)).toEqual(["alice", "bob"]);
  });

  it("removes a kicked player (player-removed carries the public player)", () => {
    act(() => mockSocket.fire("player-removed", { ...mockPlayers[2] }));
    expect(optionNames(r.root)).toEqual(["alice", "bob"]);
  });

  it("drops my pick if that player leaves before the reveal", () => {
    press(r.root, "carol");
    act(() => mockSocket.fire("player-left", "carol"));
    act(() => { jest.advanceTimersByTime(200); }); // coalesced: the withdrawal goes out 200 ms after the pick
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "" }));
    // Sent when tapped, then withdrawn when carol left (EXP-148: nothing is sent at the reveal)
    expect(mockSocket.emitted.filter(([ev]) => ev === "submit-answer").map(([, d]) => d)).toEqual([{ guess: "carol" }, { guess: "" }]);
  });

  it("keeps my pick when somebody else leaves", () => {
    press(r.root, "alice");
    act(() => mockSocket.fire("player-left", "carol"));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    expect(mockSocket.emitted.filter(([ev]) => ev === "submit-answer").map(([, d]) => d)).toEqual([{ guess: "alice" }]);
  });

  it("new-host moves the host flag (sent right before player-left, handled in one batch)", () => {
    // Server order on a host leave: new-host, then player-left, back to back (no render in between)
    act(() => {
      mockSocket.fire("new-host", { ...mockPlayers[1], isHost: true });
      mockSocket.fire("player-left", "alice");
    });
    expect(optionPlayers(r.root)).toEqual([["bob", true], ["carol", false]]);
  });

  it("a merely disconnected player stays an option (DEC-016)", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 1, totalRounds: 10, photo: "/temp/x.jpg",
      correctAnswer: "", duration: 4_000, held: false, pause: null, scores: [],
      players: mockPlayers.map((p) => (p.username === "carol" ? { ...p, connected: false } : p)),
    }));
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
  });

  it("stops listening on unmount", () => {
    act(() => r.unmount());
    mounted = false;
    for (const ev of ["player-left", "player-removed", "new-host"]) expect(mockSocket.handlers.get(ev)?.size ?? 0).toBe(0);
  });
});
