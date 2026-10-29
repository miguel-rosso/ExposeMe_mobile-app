import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { StyleSheet } from "react-native";
import { formatCountdown, turnUploadAction } from "../app/utils/gameState";
import { useGameConnection } from "../app/hooks/useGameConnection";
import { GameStateSnapshot } from "../app/models/interfaces";
import { TEST_IDS, playerOptionId } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test: a cold transform of
// the screen and its imports must not count against the 5 s per-test timeout
import GameScreen from "../app/screens/GameScreen";
import { ANSWER_STATE_BORDER } from "../app/components/AnswerOption";

// EXP-006 / DEC-009: losing the socket mid-game keeps the game screen, rejoins on reconnect and renders the
// server's game-state snapshot; a server pause shows its countdown.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

// ── Pure helpers ─────────────────────────────────────────

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  phase: "answering",
  round: 3,
  totalRounds: 10,
  photo: "/temp/1-a.jpg",
  correctAnswer: null,
  yourGuess: null,
  duration: 4200,
  phaseTotal: 7700,
  held: false,
  pause: null,
  scores: [{ username: "alice", points: 2, isHost: true, lastAnswerCorrect: false, lastGuess: "" }],
  players: [],
  roundOptions: [],
  ...over,
});

describe("turnUploadAction / formatCountdown", () => {
  it("uploads once per round, re-sends the uploaded photo, waits for one in flight", () => {
    expect(turnUploadAction(null, 2)).toBe("upload");
    expect(turnUploadAction({ attempt: 2 }, 2)).toBe("wait");
    expect(turnUploadAction({ attempt: 2, url: "/temp/1-a.jpg" }, 2)).toBe("resend");
    expect(turnUploadAction({ attempt: 2, url: "/temp/1-a.jpg" }, 3)).toBe("upload");
  });

  it("formats the pause countdown as m:ss", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
    expect(formatCountdown(299_001)).toBe("5:00");
    expect(formatCountdown(299_000)).toBe("4:59");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

// ── useGameConnection ────────────────────────────────────

describe("useGameConnection", () => {
  const setup = () => {
    const socket = new FakeSocket();
    const onLeave = jest.fn();
    const saveRejoinToken = jest.fn();
    const getRejoinToken = jest.fn(async () => "tok-123");
    let state!: { connected: boolean };
    const Probe = () => {
      state = useGameConnection({ socket: socket as any, gameCode: "123456", username: "bob", getRejoinToken, saveRejoinToken, onLeave });
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Probe />); });
    return { socket, onLeave, saveRejoinToken, getRejoinToken, get state() { return state; }, r };
  };

  it("a dropped socket keeps the game (no leave) and shows reconnecting", () => {
    const t = setup();
    expect(t.state.connected).toBe(true);
    act(() => { t.socket.connected = false; t.socket.fire("disconnect", "transport close"); });
    expect(t.state.connected).toBe(false);
    expect(t.onLeave).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("rejoins with the rejoin token on reconnect and stores the token again", async () => {
    const t = setup();
    act(() => { t.socket.fire("disconnect", "ping timeout"); });
    await act(async () => { t.socket.fire("connect"); });
    await flush();
    expect(t.state.connected).toBe(true);
    expect(t.getRejoinToken).toHaveBeenCalledWith("123456", "bob");
    expect(t.socket.emitted).toContainEqual(["join-create-game", { gameCode: "123456", username: "bob", rejoinToken: "tok-123" }]);
    act(() => t.socket.fire("room-of-game", { success: true, room: { gameCode: "123456", players: [], rounds: 10 }, rejoinToken: "tok-123" }));
    expect(t.saveRejoinToken).toHaveBeenCalledWith("123456", "bob", "tok-123");
    expect(t.onLeave).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("leaves when the rejoin is refused or the server kicked us", () => {
    const t = setup();
    act(() => t.socket.fire("room-of-game", { success: false, message: "Game not found" }));
    expect(t.onLeave).toHaveBeenCalledWith("Game not found");
    act(() => t.socket.fire("disconnect", "io server disconnect"));
    expect(t.onLeave).toHaveBeenCalledTimes(2);
    act(() => t.r.unmount());
  });

  it("removes only its own listeners on unmount", () => {
    const t = setup();
    const other = jest.fn();
    t.socket.on("connect", other);
    act(() => t.r.unmount());
    expect(t.socket.listenerCount("disconnect")).toBe(0);
    expect(t.socket.listenerCount("room-of-game")).toBe(0);
    expect(t.socket.listenerCount("connect")).toBe(1);
  });
});

// ── GameScreen ───────────────────────────────────────────

const mockReplace = jest.fn();
const mockSocket = new FakeSocket();
const mockPlayersProvider: { current: { username: string; points: number; isHost: boolean }[] } = { current: [] };
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => {
  const actual = jest.requireActual("../app/providers/GameContext");
  return {
    ...actual,
    useGameContext: () => ({
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider: mockPlayersProvider.current, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
      plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    }),
  };
});
jest.mock("../app/providers/PhotoContext", () => ({ usePhotoContext: () => ({ getRandomPhoto: jest.fn(), setPhotoUri: jest.fn() }) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

describe("GameScreen reconnect handling", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("stays on the game screen on disconnect, shows Reconnecting…, then the paused countdown", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });

    act(() => { mockSocket.connected = false; mockSocket.fire("disconnect", "transport close"); });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.reconnectingBanner)).toBe(true);

    // Reconnect → rejoin → snapshot of a paused answering phase
    mockSocket.emitted = [];
    await act(async () => { mockSocket.connected = true; mockSocket.fire("connect"); });
    await flush();
    expect(mockSocket.emitted).toContainEqual(["join-create-game", { gameCode: "123456", username: "bob", rejoinToken: "tok-123" }]);
    act(() => mockSocket.fire("game-state", snapshot({ pause: { duration: 299_000, waitingFor: [], pause: 1, maxPauses: 3 } })));
    expect(has(r.root, TEST_IDS.reconnectingBanner)).toBe(false);
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(true);
    const countdown = () => r.root.find((n) => n.props.testID === TEST_IDS.pausedCountdown).props.children;
    expect(countdown()).toBe("4:59");
    const counter = () => r.root.find((n) => n.props.testID === TEST_IDS.pausedCounter).props.children;
    expect(counter()).toBe("Pause 1 of 3");
    act(() => { jest.advanceTimersByTime(60_000); });
    expect(countdown()).toBe("3:59");

    act(() => mockSocket.fire("game-resumed", { phase: "answering", duration: 4200 }));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(false);

    // A later pause gets a full countdown again; the last one warns that the game will end
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 3, maxPauses: 3 }));
    expect(countdown()).toBe("5:00");
    expect(counter()).toBe("Pause 3 of 3");
    expect(has(r.root, TEST_IDS.pausedLastWarning)).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  // The pause ended while I was away: a snapshot without a pause closes the paused countdown
  it("closes the paused countdown when a rejoin snapshot is no longer paused", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(true);
    act(() => mockSocket.fire("game-state", snapshot({ pause: null })));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(false);
    act(() => r.unmount());
  });

  // EXP-148: the server only takes answers while answering; a pick sent while offline is re-sent from the snapshot
  it("sends nothing when the snapshot says reveal (the answer is public by then)", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    mockSocket.emitted = [];
    act(() => mockSocket.fire("game-state", snapshot({ phase: "reveal", correctAnswer: "alice" })));
    expect(mockSocket.emitted.filter(([ev]) => ev === "submit-answer")).toEqual([]);
    act(() => r.unmount());
  });

  it("re-sends my pick of the same round when the snapshot says answering", async () => {
    const players = [
      { username: "alice", points: 2, isHost: true, connected: true, lastAnswerCorrect: false, lastGuess: "" },
      { username: "bob", points: 0, isHost: false, connected: true, lastAnswerCorrect: false, lastGuess: "" },
    ];
    mockPlayersProvider.current = players;
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("game-state", snapshot({ players })));
    const pick = r.root.find((n) => n.props.testID === playerOptionId("alice") && typeof n.props.onPress === "function");
    act(() => pick.props.onPress());
    expect(mockSocket.emitted).toContainEqual(["submit-answer", { guess: "alice" }]);
    mockSocket.emitted = [];
    act(() => mockSocket.fire("game-state", snapshot({ players, duration: 3000 })));
    expect(mockSocket.emitted.filter(([ev]) => ev === "submit-answer")).toEqual([["submit-answer", { guess: "alice" }]]);
    act(() => r.unmount());
    mockPlayersProvider.current = [];
  });

  it("drops the colour of a pick made while offline when the snapshot comes back in reveal", async () => {
    const players = [
      { username: "alice", points: 2, isHost: true, connected: true, lastAnswerCorrect: false, lastGuess: "" },
      { username: "bob", points: 0, isHost: false, connected: true, lastAnswerCorrect: false, lastGuess: "" },
    ];
    mockPlayersProvider.current = players;
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("game-state", snapshot({ players })));
    const option = () => r.root.findAll((n) => n.props.testID === playerOptionId("alice") && typeof n.type === "string")[0];
    const mark = () => StyleSheet.flatten(option().props.style).borderColor;
    act(() => { mockSocket.connected = false; mockSocket.fire("disconnect", "transport close"); });
    act(() => r.root.find((n) => n.props.testID === playerOptionId("alice") && typeof n.props.onPress === "function").props.onPress());
    expect(mark()).toBe(ANSWER_STATE_BORDER.selected);
    mockSocket.connected = true;
    act(() => mockSocket.fire("game-state", snapshot({ players, phase: "reveal", correctAnswer: "alice" })));
    expect(mark()).toBe(ANSWER_STATE_BORDER.idle); // never reached the server: neither green nor red
    act(() => r.unmount());
    mockPlayersProvider.current = [];
  });
});
