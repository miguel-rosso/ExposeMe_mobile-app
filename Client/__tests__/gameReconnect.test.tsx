import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { applyGameState, formatCountdown, GameStateSetters, turnUploadAction } from "../app/utils/gameState";
import { useGameConnection } from "../app/hooks/useGameConnection";
import { GameStateSnapshot } from "../app/models/interfaces";
import { TEST_IDS } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test: a cold transform of
// the screen and its imports must not count against the 5 s per-test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-006 / DEC-009: losing the socket mid-game keeps the game screen, rejoins on reconnect and renders the
// server's game-state snapshot; a server pause shows its countdown.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// ── Fake socket ──────────────────────────────────────────

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  connect = jest.fn(() => this);
  disconnect = jest.fn(() => this);
  removeAllListeners = jest.fn(() => this);
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn?: Handler) {
    if (fn) this.handlers.get(ev)?.delete(fn);
    else this.handlers.delete(ev);
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
  listeners(ev: string) {
    return this.handlers.get(ev)?.size ?? 0;
  }
}

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

// ── Pure helpers ─────────────────────────────────────────

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  phase: "answering",
  round: 3,
  totalRounds: 10,
  owner: "alice",
  photo: "/temp/1-a.jpg",
  correctAnswer: null,
  duration: 4200,
  held: false,
  pause: null,
  scores: [{ username: "alice", points: 2, isHost: true, lastAnswerCorrect: false, lastGuess: "" }],
  players: [],
  ...over,
});

const makeSetters = () => {
  const s = {
    setPhoto: jest.fn(), setPhotoOwner: jest.fn(), setRound: jest.fn(), setPhase: jest.fn(),
    setPhaseDuration: jest.fn(), setPhaseKey: jest.fn(), setCorrectAnswer: jest.fn(), setScores: jest.fn(),
    setMySelection: jest.fn(), setGameHeld: jest.fn(), setPressing: jest.fn(), setPause: jest.fn(),
  };
  return s as typeof s & GameStateSetters;
};

describe("applyGameState", () => {
  it("renders the current answering phase with the remaining time and keeps the guess of the same round", () => {
    const s = makeSetters();
    const r = applyGameState(snapshot(), "http://srv", { round: 3, owner: "alice" }, s);
    expect(r).toEqual({ gameOver: false, sendReady: false, submitGuess: false });
    expect(s.setPhoto).toHaveBeenCalledWith("http://srv/temp/1-a.jpg");
    expect(s.setPhotoOwner).toHaveBeenCalledWith("alice");
    expect(s.setPhase).toHaveBeenCalledWith("answering");
    expect(s.setPhaseDuration).toHaveBeenCalledWith(4200);
    expect(s.setPause).toHaveBeenCalledWith(null);
    expect(s.setMySelection).not.toHaveBeenCalled();
  });

  it("clears the guess when the round changed while away", () => {
    const s = makeSetters();
    applyGameState(snapshot(), "http://srv", { round: 2, owner: "bob" }, s);
    expect(s.setMySelection).toHaveBeenCalledWith("");
  });

  it("asks to submit the guess in reveal and shows scores in scores", () => {
    const s = makeSetters();
    expect(applyGameState(snapshot({ phase: "reveal", correctAnswer: "alice" }), "", { round: 3, owner: "alice" }, s).submitGuess).toBe(true);
    expect(s.setCorrectAnswer).toHaveBeenCalledWith("alice");
    const s2 = makeSetters();
    applyGameState(snapshot({ phase: "scores", correctAnswer: "alice" }), "", { round: 3, owner: "alice" }, s2);
    expect(s2.setScores).toHaveBeenCalledWith(snapshot().scores);
  });

  it("shows the server's pause countdown", () => {
    const s = makeSetters();
    const pause = { duration: 299_000, waitingFor: [], pause: 2, maxPauses: 3 };
    applyGameState(snapshot({ pause }), "", { round: 3, owner: "alice" }, s);
    expect(s.setPause).toHaveBeenCalledWith(pause);
  });

  it("waiting for a photo: the waiting screen for the next round (EXP-039); ready phase: send im-ready again", () => {
    const s = makeSetters();
    const r = applyGameState(snapshot({ phase: "waiting-photo", owner: null, photo: null, duration: 9_000 }), "", { round: 3, owner: "alice" }, s);
    expect(r.sendReady).toBe(false);
    expect(s.setPhoto).toHaveBeenCalledWith(null);
    expect(s.setPhase).toHaveBeenCalledWith("waiting-photo");
    expect(s.setRound).toHaveBeenCalledWith(4);
    expect(s.setPhaseDuration).toHaveBeenCalledWith(9_000);
    expect(applyGameState(snapshot({ phase: null, owner: null, photo: null }), "", { round: 0, owner: "" }, makeSetters()).sendReady).toBe(true);
  });

  it("reports game over when the game ended while away", () => {
    const s = makeSetters();
    expect(applyGameState(snapshot({ started: false, phase: null }), "", { round: 3, owner: "alice" }, s).gameOver).toBe(true);
    expect(s.setPhoto).not.toHaveBeenCalled();
  });
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
    expect(t.socket.listeners("disconnect")).toBe(0);
    expect(t.socket.listeners("room-of-game")).toBe(0);
    expect(t.socket.listeners("connect")).toBe(1);
  });
});

// ── GameScreen ───────────────────────────────────────────

const mockReplace = jest.fn();
const mockSocket = new FakeSocket();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => {
  const actual = jest.requireActual("../app/providers/GameContext");
  return {
    ...actual,
    useGameContext: () => ({
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
      uploadPlantedPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
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

  it("submits the guess when the snapshot says reveal (the round-reveal was missed)", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    mockSocket.emitted = [];
    act(() => mockSocket.fire("game-state", snapshot({ phase: "reveal", correctAnswer: "alice" })));
    expect(mockSocket.emitted).toContainEqual(["submit-answer", { guess: "" }]);
    act(() => r.unmount());
  });
});
