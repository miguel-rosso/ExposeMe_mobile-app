import React from "react";
import { StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS, playerOptionId } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { ANSWER_STATE_BORDER } from "../app/components/AnswerOption";

// EXP-128 / EXP-252: round-start / game-state never tell anyone, the owner included, whose photo it is before
// round-reveal: everyone votes the same way. From the reveal on (correctAnswer) the owner's screen knows the photo was
// theirs and shows the hold button in scores.

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

const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const option = (root: ReactTestInstance, name: string) =>
  root.findAll((n) => n.props.testID === playerOptionId(name) && typeof n.type === "string")[0];
// An option shows its state in its border colour (EXP-253)
const markOf = (root: ReactTestInstance, name: string) => StyleSheet.flatten(option(root, name).props.style).borderColor;
const press = (root: ReactTestInstance, name: string) =>
  act(() => root.find((n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function").props.onPress());
const answers = () => mockSocket.emitted.filter(([ev]) => ev === "submit-answer").map(([, d]) => d);

const GREEN = ANSWER_STATE_BORDER.correct;
const RED = ANSWER_STATE_BORDER.wrong;
const BLUE = ANSWER_STATE_BORDER.selected;
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
    act(() => mockSocket.fire("round-reveal", { correctAnswer, duration: 3_000, yourGuess: "" }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
  };

  it("a non-owner votes, sees no hold button, and the reveal marks the right answer", () => {
    act(() => mockSocket.fire("round-start", START));
    // Nothing on screen tells whose photo it is: no option is highlighted
    for (const n of ["alice", "bob", "carol"]) expect(markOf(r.root, n)).not.toBe(GREEN);
    press(r.root, "alice");
    expect(markOf(r.root, "alice")).toBe(BLUE);
    // EXP-148: the pick is sent when tapped, during answering (the server ignores answers once the reveal is out)
    expect(answers()).toEqual([{ guess: "alice" }]);

    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    expect(answers()).toEqual([{ guess: "alice" }]); // nothing sent at the reveal
    expect(markOf(r.root, "alice")).toBe(GREEN);
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    expect(r.root.find((n) => n.props.testID === "score-correct-answer").props.children).toBe("alice");
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
  });

  // EXP-148: every tap sends the pick, so the last one before the answer time ends is the one that counts
  it("sends each new pick while answering, and nothing once the reveal arrives", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    act(() => { jest.advanceTimersByTime(250); });
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    expect(markOf(r.root, "alice")).toBe(BLUE);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
  });

  // Rapid taps are coalesced (at most one send per 200 ms, then the latest pick), so the server's per-socket limit
  // never drops the pick that counts
  it("coalesces rapid picks: sends the first at once and the latest one 200 ms later", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "bob");
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "carol" }]);
    expect(markOf(r.root, "alice")).toBe(BLUE); // the screen follows every tap at once
    act(() => { jest.advanceTimersByTime(199); });
    expect(answers()).toEqual([{ guess: "carol" }]);
    act(() => { jest.advanceTimersByTime(1); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toHaveLength(2);
  });

  it("a pick still waiting to be sent is dropped when the next round starts", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "alice");
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    act(() => { jest.advanceTimersByTime(500); });
    expect(answers()).toEqual([{ guess: "carol" }]);
  });

  // The bar is drawn with the server's duration (answer time minus a grace): once it ends, taps are no longer taken
  it("stops taking picks when the answer bar ends", () => {
    act(() => mockSocket.fire("round-start", START));
    expect(typeof mockBar.onEnd).toBe("function");
    act(() => mockBar.onEnd!());
    press(r.root, "alice");
    act(() => { jest.advanceTimersByTime(500); });
    expect(answers()).toEqual([]);
    expect(markOf(r.root, "alice")).not.toBe(BLUE);
    expect(option(r.root, "alice").props.accessibilityState?.disabled ?? option(r.root, "alice").props.disabled).toBe(true);
    // A new round opens them again
    act(() => mockSocket.fire("round-start", { ...START, round: 2 }));
    press(r.root, "alice");
    expect(answers()).toEqual([{ guess: "alice" }]);
  });

  // EXP-227: a pick waiting for its throttle slot must not leave after the bar (the server drops it in reveal)
  it("sends a pick still waiting for its throttle slot as soon as the answer bar ends", () => {
    act(() => mockSocket.fire("round-start", START));
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
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    expect(markOf(r.root, "alice")).toBe(GREEN);
  });

  // EXP-233: the throttle slot counts from the last send, the trailing one included
  it("after a trailing send, the next tap waits for its own 200 ms slot", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "alice");
    act(() => { jest.advanceTimersByTime(200); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => { jest.advanceTimersByTime(100); });
    press(r.root, "bob");
    expect(answers()).toHaveLength(2);
    act(() => { jest.advanceTimersByTime(100); });
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }, { guess: "bob" }]);
  });

  // EXP-233: a rejoin snapshot of the same round re-sends the current pick at once, taking a pick still waiting
  it("a rejoin snapshot re-sends a pick still waiting at once, without a trailing duplicate", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "alice");
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 1, totalRounds: 10, photo: START.photo, correctAnswer: null,
      yourGuess: null, duration: 4_000, held: false, pause: null, scores: [], players: mockPlayers, roundOptions: mockPlayers,
    }));
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toHaveLength(2);
  });

  // EXP-233: leaving the screen drops a pick still waiting for its throttle slot
  it("a pick still waiting is not sent after the screen unmounts", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "alice");
    act(() => r.unmount());
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toEqual([{ guess: "carol" }]);
    act(() => { r = TestRenderer.create(<></>); }); // afterEach unmounts it
  });

  // EXP-227 / EXP-230: the reveal colours the pick the server recorded, not a later local tap
  it("the reveal colours the recorded pick, not one still waiting when answering ended", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    press(r.root, "alice"); // waits for its throttle slot; the reveal arrives first
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "carol" }));
    expect(markOf(r.root, "carol")).toBe(RED);
    expect(markOf(r.root, "alice")).not.toBe(GREEN);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(answers()).toEqual([{ guess: "carol" }]); // too late: never sent in reveal
  });

  // EXP-230: a change sent in time from the phone that reached the server after the close never counted: the reveal
  // colours the answer the server recorded (the earlier pick), so it agrees with the scoreboard that follows
  it("the reveal colours the server's recorded answer, not a change that arrived after the close", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    act(() => { jest.advanceTimersByTime(250); });
    press(r.root, "alice"); // sent, but it reached the server after the close
    expect(answers()).toEqual([{ guess: "carol" }, { guess: "alice" }]);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "carol" }));
    expect(markOf(r.root, "carol")).toBe(RED);
    expect(markOf(r.root, "alice")).not.toBe(GREEN);
  });

  // The scoreboard lists each player's recorded guess; no options are drawn under it (EXP-141), so none can show a stale pick
  it("the scores show no stale colour: the options are gone under the scoreboard", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "alice");
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "alice" }));
    expect(markOf(r.root, "alice")).toBe(GREEN);
    const score = (username: string, lastGuess: string) =>
      ({ username, points: 0, isHost: false, lastAnswerCorrect: false, lastGuess });
    act(() => mockSocket.fire("round-scores", {
      scores: [score("alice", "bob"), score("bob", "carol"), score("carol", "")], round: 1, totalRounds: 10, duration: 5_000,
    }));
    for (const n of ["alice", "bob", "carol"]) expect(option(r.root, n)).toBeUndefined();
  });

  it("a wrong guess turns red at the reveal", () => {
    act(() => mockSocket.fire("round-start", START));
    press(r.root, "carol");
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "carol" }));
    expect(markOf(r.root, "carol")).toBe(RED);
    expect(markOf(r.root, "alice")).not.toBe(GREEN); // only my own selection is coloured
  });

  // EXP-252: nobody is told whose photo it is before the reveal, the owner included (they may not recognise it)
  it("the owner (bob, not told) plays like everyone: every option, his own name included, and his pick is sent", () => {
    act(() => mockSocket.fire("round-start", START));
    expect(has(r.root, "own-photo-hint")).toBe(false);
    for (const n of ["alice", "bob", "carol"]) {
      expect(option(r.root, n).props.accessibilityState?.disabled ?? option(r.root, n).props.disabled).toBeFalsy();
    }
    press(r.root, "bob");
    expect(markOf(r.root, "bob")).toBe(BLUE);
    expect(answers()).toEqual([{ guess: "bob" }]);
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);

    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000, yourGuess: "bob" }));
    expect(markOf(r.root, "bob")).toBe(GREEN);
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false); // the server takes holds in scores only
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
    expect(answers()).toEqual([{ guess: "bob" }]);
  });

  it("the hold button follows the revealed answer, also from a rejoin snapshot; the next round resets it", () => {
    const snapshot = (phase: string, correctAnswer: string | null) => ({
      started: true, phase, round: 1, totalRounds: 10, photo: "/temp/x.jpg",
      correctAnswer, yourGuess: correctAnswer === null ? null : "", duration: 4_000, held: false, pause: null, scores: [],
      players: mockPlayers, roundOptions: mockPlayers,
    });
    act(() => mockSocket.fire("game-state", snapshot("answering", null)));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
    act(() => mockSocket.fire("game-state", snapshot("scores", "bob")));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
    act(() => mockSocket.fire("round-start", { ...START, round: 2 }));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
    toScores("alice");
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
  });
});
