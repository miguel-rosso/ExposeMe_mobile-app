import React from "react";
import { StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import tw from "twrnc";
import { TEST_IDS, playerOptionId } from "../app/utils/testIds";
import en from "../app/i18n/en";
import es from "../app/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-128: round-start / game-state never name the photo owner before round-reveal. The game screen learns the photo
// is mine only from `isOwner` (hold button, no voting); everyone sees the right answer from round-reveal on.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  connect = jest.fn(() => this);
  disconnect = jest.fn(() => this);
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
}

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
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
jest.mock("@/app/components/modals/ScoreModal", () => (p: { visible: boolean; correctAnswer: string }) => {
  const { Text } = require("react-native");
  return p.visible ? <Text testID="score-correct-answer">{p.correctAnswer}</Text> : null;
});
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
const mockBar: { onEnd?: () => void } = {};
jest.mock("@/app/components/ProgressBar", () => (p: { onEnd?: () => void }) => { mockBar.onEnd = p.onEnd; return null; });

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const textOf = (root: ReactTestInstance, id: string) => root.find((n) => n.props.testID === id && typeof n.type === "string").props.children;
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const option = (root: ReactTestInstance, name: string) =>
  root.findAll((n) => n.props.testID === playerOptionId(name) && typeof n.type === "string")[0];
const bgOf = (root: ReactTestInstance, name: string) => StyleSheet.flatten(option(root, name).props.style).backgroundColor;
const press = (root: ReactTestInstance, name: string) =>
  act(() => root.find((n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function").props.onPress());
const answers = () => mockSocket.emitted.filter(([ev]) => ev === "submit-answer").map(([, d]) => d);

const GREEN = tw`bg-green-500`.backgroundColor;
const RED = tw`bg-red-500`.backgroundColor;
const BLUE = tw`bg-blue-500`.backgroundColor;
const START = { photo: "/temp/x.jpg", round: 1, duration: 8_000 };

describe("GameScreen: whose photo it is (EXP-128)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    mockSocket.emitted = [];
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const toScores = (correctAnswer: string) => {
    act(() => mockSocket.fire("round-reveal", { correctAnswer, duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
  };

  it("a non-owner votes, sees no hold button, and the reveal marks the right answer", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    // Nothing on screen tells whose photo it is: no option is highlighted
    for (const n of ["alice", "bob", "carol"]) expect(bgOf(r.root, n)).not.toBe(GREEN);
    expect(has(r.root, TEST_IDS.ownPhotoHint)).toBe(false);
    press(r.root, "alice");
    expect(bgOf(r.root, "alice")).toBe(BLUE);
    // EXP-148: the pick is sent when tapped, during answering (the server ignores answers once the reveal is out)
    expect(answers()).toEqual([{ guess: "alice" }]);

    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(answers()).toEqual([{ guess: "alice" }]); // nothing sent at the reveal
    expect(bgOf(r.root, "alice")).toBe(GREEN);
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    expect(r.root.find((n) => n.props.testID === "score-correct-answer").props.children).toBe("alice");
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
  });

  // EXP-148: every tap sends the pick, so the last one before the answer time ends is the one that counts
  it("sends each new pick while answering, and nothing once the reveal arrives", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    act(() => { jest.advanceTimersByTime(250); });
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    expect(bgOf(r.root, "alice")).toBe(BLUE);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
  });

  // Rapid taps are coalesced (at most one send per 200 ms, then the latest pick), so the server's per-socket limit
  // never drops the pick that counts
  it("coalesces rapid picks: sends the first at once and the latest one 200 ms later", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    press(r.root, "bob");
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "carol" }]);
    expect(bgOf(r.root, "alice")).toBe(BLUE); // the screen follows every tap at once
    act(() => { jest.advanceTimersByTime(199); });
    expect(answers()).toEqual([{ guess: "carol" }]);
    act(() => { jest.advanceTimersByTime(1); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toHaveLength(2);
  });

  it("a pick still waiting to be sent is dropped when the next round starts", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    press(r.root, "alice");
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    act(() => { jest.advanceTimersByTime(500); });
    expect(answers()).toEqual([{ guess: "carol" }]);
  });

  // The bar is drawn with the server's duration (answer time minus a grace): once it ends, taps are no longer taken
  it("stops taking picks when the answer bar ends", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    expect(typeof mockBar.onEnd).toBe("function");
    act(() => mockBar.onEnd!());
    press(r.root, "alice");
    act(() => { jest.advanceTimersByTime(500); });
    expect(answers()).toEqual([]);
    expect(bgOf(r.root, "alice")).not.toBe(BLUE);
    expect(option(r.root, "alice").props.accessibilityState?.disabled ?? option(r.root, "alice").props.disabled).toBe(true);
    // A new round opens them again
    act(() => mockSocket.fire("round-start", { ...START, round: 2, isOwner: false }));
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "alice" }]);
  });

  // EXP-227: a pick waiting for its throttle slot must not leave after the bar (the server drops it in reveal)
  it("sends a pick still waiting for its throttle slot as soon as the answer bar ends", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    act(() => { jest.advanceTimersByTime(50); });
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "carol" }]);
    act(() => mockBar.onEnd!());
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toHaveLength(2); // no trailing duplicate
    press(r.root, "bob"); // after the close: ignored
    expect(answers()).toHaveLength(2);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(bgOf(r.root, "alice")).toBe(GREEN);
  });

  // EXP-227: the reveal and scores colour the pick the server can have counted, not a later local tap
  it("the reveal colours the last pick sent, not one still waiting when answering ended", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    press(r.root, "alice"); // waits for its throttle slot; the reveal arrives first
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(bgOf(r.root, "carol")).toBe(RED);
    expect(bgOf(r.root, "alice")).not.toBe(GREEN);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toEqual([{ guess: "carol" }]); // too late: never sent in reveal
  });

  // The scoreboard lists each player's recorded guess; no options are drawn under it (EXP-141), so none can show a stale pick
  it("the scores show no stale colour: the options are gone under the scoreboard", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    act(() => { jest.advanceTimersByTime(250); });
    press(r.root, "alice"); // sent, but it reached the server after the close
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(bgOf(r.root, "alice")).toBe(GREEN);
    const score = (username: string, lastGuess: string) =>
      ({ username, points: 0, isHost: false, lastAnswerCorrect: false, lastGuess });
    act(() => mockSocket.fire("round-scores", {
      scores: [score("alice", "bob"), score("bob", "carol"), score("carol", "")], round: 1, totalRounds: 10, duration: 5_000,
    }));
    for (const n of ["alice", "bob", "carol"]) expect(option(r.root, n)).toBeUndefined();
  });

  it("a wrong guess turns red at the reveal", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: false }));
    press(r.root, "carol");
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(bgOf(r.root, "carol")).toBe(RED);
    expect(bgOf(r.root, "alice")).not.toBe(GREEN); // only my own selection is coloured
  });

  it("the owner gets a hint instead of the options while answering, can't vote, and gets the hold button in scores", () => {
    act(() => mockSocket.fire("round-start", { ...START, isOwner: true }));
    expect(textOf(r.root, TEST_IDS.ownPhotoHint)).toBe(en.ownPhotoHint);
    expect(option(r.root, "alice")).toBeUndefined();
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    expect(has(r.root, TEST_IDS.ownPhotoHint)).toBe(false);
    expect(option(r.root, "bob").props.accessibilityState?.disabled ?? option(r.root, "bob").props.disabled).toBe(true);
    expect(bgOf(r.root, "bob")).not.toBe(BLUE);
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    expect(answers()).toEqual([]); // the owner never votes
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
  });

  it("the own-photo hint is translated (en/es)", () => {
    expect(en.ownPhotoHint).toBeTruthy();
    expect(es.ownPhotoHint).toBeTruthy();
    expect(es.ownPhotoHint).not.toBe(en.ownPhotoHint);
  });

  it("isOwner from a rejoin snapshot drives the same UI; the next round resets it", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "scores", round: 1, totalRounds: 10, isOwner: true, photo: "/temp/x.jpg",
      correctAnswer: "bob", duration: 4_000, held: false, pause: null, scores: [], players: mockPlayers,
    }));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
    act(() => mockSocket.fire("round-start", { ...START, round: 2, isOwner: false }));
    toScores("alice");
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
  });
});
