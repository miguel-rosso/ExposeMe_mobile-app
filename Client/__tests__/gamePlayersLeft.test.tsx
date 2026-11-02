import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { playerOptionId } from "../app/utils/testIds";
import { GameStateSnapshot } from "../app/models/interfaces";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-042: a player who leaves (player-left) or is kicked (player-removed) mid-game stops being an answer option;
// new-host moves the host flag. A player merely disconnected (still in the room) stays an option (DEC-016).
// EXP-301 / DEC-038: one who leaves during a round stays its option, with my pick on them, until the next photo wait:
// they may be the photo's owner (still the answer), and the app can't tell which leaver that is.

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
// The answer option drawn for `name`, in the state the screen gives it (idle / selected / correct / wrong)
const optionState = (root: ReactTestInstance, name: string) =>
  root.find((n) => n.props.username === name && typeof n.props.state === "string").props.state;
const submitted = () => mockSocket.emitted.filter(([ev]) => ev === "submit-answer").map(([, d]) => d);
const START = { photo: "/temp/x.jpg", round: 1, duration: 8_000 };
const NEXT_WAIT = { round: 2, duration: 15_000 };
const NEXT_START = { photo: "/temp/y.jpg", round: 2, duration: 8_000 };
// Rejoin snapshot of round 1 in answering: carol, one of its options, has left the room
const roundSnapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true, phase: "answering", round: 1, totalRounds: 10, photo: START.photo, correctAnswer: null,
  yourGuess: null, duration: 4_000, phaseTotal: 7_700, held: false, holdsLeft: 3, pause: null, scores: [],
  players: mockPlayers.slice(0, 2), roundOptions: mockPlayers, ...over,
});

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

  it("keeps a player who left during the round as an option, in their place, until the next photo wait", () => {
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    act(() => mockSocket.fire("player-left", "alice"));
    act(() => mockSocket.fire("player-removed", { ...mockPlayers[2] })); // kicked: the same
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "" }));
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    act(() => mockSocket.fire("waiting-photo", NEXT_WAIT));
    act(() => mockSocket.fire("round-start", NEXT_START));
    expect(optionNames(r.root)).toEqual(["bob"]);
  });

  it("removes a player who left between rounds", () => {
    act(() => mockSocket.fire("waiting-photo", NEXT_WAIT));
    act(() => mockSocket.fire("player-left", "carol"));
    act(() => mockSocket.fire("round-start", NEXT_START));
    expect(optionNames(r.root)).toEqual(["alice", "bob"]);
  });

  // EXP-301: the owner who left is still the answer, so a right pick on them must not be withdrawn
  it("keeps my pick on a player who left, and the reveal colours it", () => {
    press(r.root, "carol");
    act(() => mockSocket.fire("player-left", "carol"));
    act(() => { jest.advanceTimersByTime(1_000); });
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000, yourGuess: "carol" }));
    // Sent once, when tapped: nothing withdraws it (EXP-148: nothing is sent at the reveal either)
    expect(submitted()).toEqual([{ guess: "carol" }]);
    expect(optionState(r.root, "carol")).toBe("correct");
  });

  it("still takes a pick on a player who left during the round", () => {
    act(() => mockSocket.fire("player-left", "carol"));
    press(r.root, "carol");
    expect(submitted()).toEqual([{ guess: "carol" }]);
    expect(optionState(r.root, "carol")).toBe("selected");
  });

  it("keeps my pick when somebody else leaves", () => {
    press(r.root, "alice");
    act(() => mockSocket.fire("player-left", "carol"));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    expect(submitted()).toEqual([{ guess: "alice" }]);
  });

  it("new-host moves the host flag (sent right before player-left, handled in one batch)", () => {
    // Server order on a host leave: new-host, then player-left, back to back (no render in between)
    act(() => {
      mockSocket.fire("new-host", { ...mockPlayers[1], isHost: true });
      mockSocket.fire("player-left", "alice");
    });
    act(() => mockSocket.fire("waiting-photo", NEXT_WAIT));
    act(() => mockSocket.fire("round-start", NEXT_START));
    expect(optionPlayers(r.root)).toEqual([["bob", true], ["carol", false]]);
  });

  // EXP-301: a reconnect in the same round re-sends my pick on the owner who left (the server still takes it)
  it("keeps the round's leavers, and re-sends my pick on one, after a rejoin snapshot of the same round", () => {
    press(r.root, "carol");
    act(() => mockSocket.fire("player-left", "carol"));
    mockSocket.emitted = [];
    act(() => mockSocket.fire("game-state", roundSnapshot()));
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    expect(submitted()).toEqual([{ guess: "carol" }]);
  });

  // EXP-301 / EXP-310: offline when the owner left, so the player-left never arrived: the snapshot brings them back
  it("draws a leaver it never heard of from the snapshot's round options, and the reveal colours my pick on them", () => {
    press(r.root, "carol");
    act(() => mockSocket.fire("game-state", roundSnapshot()));
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000, yourGuess: "carol" }));
    expect(optionState(r.root, "carol")).toBe("correct");
  });

  it("a merely disconnected player stays an option (DEC-016)", () => {
    act(() => mockSocket.fire("game-state", roundSnapshot({
      players: mockPlayers.map((p) => (p.username === "carol" ? { ...p, connected: false } : p)),
    })));
    expect(optionNames(r.root)).toEqual(["alice", "bob", "carol"]);
  });

  it("stops listening on unmount", () => {
    act(() => r.unmount());
    mounted = false;
    for (const ev of ["player-left", "player-removed", "new-host"]) expect(mockSocket.handlers.get(ev)?.size ?? 0).toBe(0);
  });
});
