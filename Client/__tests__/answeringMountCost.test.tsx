import React, { Profiler } from "react";
import { NativeModules, Platform } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { honourNativeAnimationDurations } from "../testUtils/nativeAnimations";

// EXP-225: Androids painted the answering phase 350-430 ms (p50) after its round-start handler ran, iPhones in ~30 ms.
// This measures what GameScreen renders and commits on the round-start transition, with the Android photo layer and the
// real progress bar, answer options and emoji buttons, and pins the cheaper mount down.
// EXP-265: still 250-420 ms (p50) on Android for answering and 120-230 ms for the scoreboard. The options are a plain
// grid (no list cells re-rendering after the mount), and the reveal and the scoreboard no longer re-render the photo
// and the emoji buttons.

// The real ids, for the checks below (the module is mocked to count renders)
const { TEST_IDS, emojiButtonId } = jest.requireActual<typeof import("../app/utils/testIds")>("../app/utils/testIds");

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const PLAYER_COUNT = 8;
const mockPlayers = Array.from({ length: PLAYER_COUNT }, (_, i) => ({
  username: `player${i + 1}`, points: 0, isHost: i === 0, connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "player1", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
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
// A plain glyph: the icon font isn't loaded in tests
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
// Every render of an answer option, the emoji buttons, the photo and the scoreboard: each one asks for its testID once
// per render (the emoji buttons, one per button: the first one counts)
const mockRenders = { options: 0, emojiButtons: 0, photo: 0, scoreboard: 0 };
jest.mock("../app/utils/testIds", () => {
  const actual = jest.requireActual("../app/utils/testIds");
  const countedId = (part: keyof typeof mockRenders, id: string) =>
    ({ enumerable: true, get: () => { mockRenders[part]++; return id; } });
  return {
    ...actual,
    TEST_IDS: Object.defineProperties({ ...actual.TEST_IDS }, {
      photoView: countedId("photo", actual.TEST_IDS.photoView),
      scoreModal: countedId("scoreboard", actual.TEST_IDS.scoreModal),
    }),
    playerOptionId: (name: string) => { mockRenders.options++; return actual.playerOptionId(name); },
    emojiButtonId: (index: number) => { if (index === 0) mockRenders.emojiButtons++; return actual.emojiButtonId(index); },
  };
});
const resetRenderCounts = () => {
  mockRenders.options = 0;
  mockRenders.emojiButtons = 0;
  mockRenders.photo = 0;
  mockRenders.scoreboard = 0;
};

const realOS = Platform.OS;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  Platform.OS = "android";
  honourNativeAnimationDurations(); // the answer bar closes the answers when it fills: not 16 ms in
});
afterAll(() => {
  Platform.OS = realOS;
  jest.restoreAllMocks();
});

// Long enough for the list's batched cell updates after a layout (50 ms batches), well before the bar ends
const SETTLE_MS = 500;
const LAYOUT = { nativeEvent: { layout: { x: 0, y: 400, width: 400, height: 800 } } };
// What the native side does after a mount: one layout event per view that listens to it, until no new view asks
// (a layout handler may mount more views with their own onLayout)
const runLayoutPass = (root: ReactTestInstance, laidOut: Set<unknown>) => {
  for (let pass = 0; pass < 5; pass++) {
    const pending = root.findAll((n) => typeof n.type === "string" && typeof n.props.onLayout === "function")
      .filter((n) => !laidOut.has(n.props.onLayout));
    if (pending.length === 0) return;
    pending.forEach((n) => { laidOut.add(n.props.onLayout); act(() => n.props.onLayout(LAYOUT)); });
  }
};
const blurredImages = (root: ReactTestInstance) =>
  root.findAll((n) => typeof n.type === "string" && n.props.blurRadius !== undefined);
const has = (root: ReactTestInstance, id: string) =>
  root.findAll((n) => n.props.testID === id && typeof n.type === "string").length > 0;

describe("GameScreen: round-start mount cost on Android (EXP-225)", () => {
  let r: TestRenderer.ReactTestRenderer;
  // What each commit of the screen had rendered so far: answer options, emoji buttons
  let commits: { options: number; emojiButtons: number }[] = [];
  const onRender = () => { commits.push({ options: mockRenders.options, emojiButtons: mockRenders.emojiButtons }); };
  const resetCounts = () => { commits = []; resetRenderCounts(); };
  // The main photo's image finished loading (the native onLoad)
  const photoLoaded = () => {
    const photo = r.root.find((n) =>
      typeof n.props.onLoad === "function" && n.props.resizeMode === "contain" && typeof n.type !== "string");
    act(() => photo.props.onLoad());
  };
  const startRound = (round: number) =>
    act(() => mockSocket.fire("round-start", { photo: `/temp/${round}.jpg`, round, duration: 8_000 }));
  // The native layout pass after a mount, then the list's own batched updates settle
  const layOut = (laidOut: Set<unknown>) => {
    runLayoutPass(r.root, laidOut);
    act(() => jest.advanceTimersByTime(SETTLE_MS));
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    mockSocket.handlers.clear();
    await act(async () => {
      r = TestRenderer.create(<Profiler id="game" onRender={onRender}><GameScreen /></Profiler>);
    });
    // Room photos need the session headers (async): let them resolve before the round
    await act(async () => {});
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 10_000 }));
    act(() => jest.advanceTimersByTime(1_000));
    resetCounts();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("paints the photo and every option in the first commit, the emoji buttons right after it", () => {
    startRound(1);
    expect(has(r.root, TEST_IDS.photoView)).toBe(true);
    expect(has(r.root, TEST_IDS.answerOptions)).toBe(true);
    expect(has(r.root, TEST_IDS.roundProgress)).toBe(true);
    expect(has(r.root, emojiButtonId(0))).toBe(true);
    expect(commits[0]).toEqual({ options: PLAYER_COUNT, emojiButtons: 0 });
    expect(commits).toHaveLength(2);
    expect(commits[1].emojiButtons).toBe(1);
  });

  it("draws the Android backdrop as one blurred image, without a layout round trip", () => {
    startRound(1);
    const laidOut = new Set<unknown>();
    layOut(laidOut);
    // The mount, the emoji buttons, and measuring the options' top (for the reaction lane) re-renders the screen once,
    // but no option
    expect(mockRenders.options).toBe(PLAYER_COUNT);
    expect(commits).toHaveLength(3);
    // The backdrop comes with the loaded photo (EXP-131): one commit of the photo alone, no option re-rendered
    const commitsBeforeLoad = commits.length;
    photoLoaded();
    expect(blurredImages(r.root)).toHaveLength(1);
    expect(commits).toHaveLength(commitsBeforeLoad + 1);
    expect(mockRenders.options).toBe(PLAYER_COUNT);

    // Later rounds: the options' top is already known and the options have no list cells reporting their layout
    // (EXP-265): the mount and the emoji buttons right after it, nothing else
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    resetCounts();
    startRound(2);
    layOut(laidOut);
    expect(mockRenders.options).toBe(PLAYER_COUNT);
    expect(commits).toHaveLength(2);
  });

  it("re-renders only the option I pick", () => {
    startRound(1);
    layOut(new Set());
    resetCounts();
    const option = r.root.find((n) => n.props.testID === "player-option-player3" && typeof n.props.onPress === "function");
    act(() => option.props.onPress());
    expect(mockRenders.options).toBe(1);
    expect(mockSocket.emitted).toContainEqual(["submit-answer", { guess: "player3" }]);
  });
});

// EXP-265: the reveal and the scoreboard only render what they change
describe("GameScreen: reveal and scoreboard render cost on Android (EXP-265)", () => {
  const ANSWERING_MS = 8_000;
  const REVEAL_MS = 3_000;
  const roundScores = mockPlayers.map((p, i) => ({ ...p, points: i * 10, lastGuess: "player2", lastAnswerCorrect: i % 2 === 0 }));
  let r: TestRenderer.ReactTestRenderer;
  // The phase of each commit of the screen ("update", or "nested-update" for one scheduled while committing)
  let commits: string[] = [];
  const resetCounts = () => { commits = []; resetRenderCounts(); };
  const pick = (name: string) => {
    const option = r.root.find((n) => n.props.testID === `player-option-${name}` && typeof n.props.onPress === "function");
    act(() => option.props.onPress());
  };
  const reveal = () => act(() => mockSocket.fire("round-reveal", { correctAnswer: "player2", duration: REVEAL_MS }));
  const showScores = () =>
    act(() => mockSocket.fire("round-scores", { scores: roundScores, round: 1, totalRounds: 10, duration: 5_000 }));
  // The answer bar runs out (the options are disabled) as the server reveals the answer
  const closeAnswers = () => act(() => jest.advanceTimersByTime(ANSWERING_MS - SETTLE_MS));
  // Native animation work sent while `run` runs: animations started, animated nodes made and dropped, values read back
  const NATIVE_ANIMATED_OPS = ["startAnimatingNode", "createAnimatedNode", "dropAnimatedNode", "getValue"] as const;
  const nativeAnimatedOps = (run: () => void) => {
    const module = NativeModules.NativeAnimatedModule as Record<string, jest.Mock>;
    NATIVE_ANIMATED_OPS.forEach((op) => module[op].mockClear());
    run();
    return Object.fromEntries(NATIVE_ANIMATED_OPS.map((op) => [op, module[op].mock.calls.length]));
  };

  // Round 1 laid out (the options' entrance over) with its photo loaded and my pick made
  beforeEach(async () => {
    jest.useFakeTimers();
    mockSocket.handlers.clear();
    await act(async () => {
      r = TestRenderer.create(<Profiler id="game" onRender={(_id, phase) => { commits.push(phase); }}><GameScreen /></Profiler>);
    });
    await act(async () => {});
    act(() => mockSocket.fire("round-start", { photo: "/temp/1.jpg", round: 1, duration: ANSWERING_MS }));
    runLayoutPass(r.root, new Set());
    act(() => jest.advanceTimersByTime(SETTLE_MS));
    const photo = r.root.find((n) =>
      typeof n.props.onLoad === "function" && n.props.resizeMode === "contain" && typeof n.type !== "string");
    act(() => photo.props.onLoad());
    pick("player3");
    resetCounts();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("reveal: one commit that re-renders only my option, not the photo or the emoji buttons", () => {
    closeAnswers();
    resetCounts();
    reveal();
    expect(commits).toEqual(["update"]);
    expect(mockRenders.options).toBe(1);
    expect(mockRenders.photo).toBe(0);
    expect(mockRenders.emojiButtons).toBe(0);
  });

  it("scores: the scoreboard is drawn once in one commit, without re-rendering the photo or the emoji buttons", () => {
    closeAnswers();
    reveal();
    act(() => jest.advanceTimersByTime(REVEAL_MS));
    resetCounts();
    showScores();
    expect(has(r.root, TEST_IDS.scoreModal)).toBe(true);
    // The owner card's entrance (react-native-animatable) sets its first frame as it mounts: nothing else re-renders
    expect(commits).toEqual(["update", "nested-update"]);
    expect(mockRenders.scoreboard).toBe(1);
    expect(mockRenders.photo).toBe(0);
    expect(mockRenders.emojiButtons).toBe(0);

    // The screen still re-renders during scores (here a reaction comes in): the scoreboard and the photo don't
    act(() => mockSocket.fire("emoji-reaction", { username: "player2", emoji: "🔥" }));
    expect(mockRenders.scoreboard).toBe(1);
    expect(mockRenders.photo).toBe(0);
  });

  it("closing the answers animates nothing on the options, and the scoreboard drops only their own motion", () => {
    // The options just stop taking picks: before EXP-265 every card's touch layer ran an opacity animation here
    // (42 new animated nodes, 10 animations with 8 players)
    const closing = nativeAnimatedOps(() => { closeAnswers(); reveal(); });
    expect(closing.createAnimatedNode).toBe(0);
    // Only the reveal's progress bar and my pick's reveal motion
    expect(closing.startAnimatingNode).toBeLessThanOrEqual(2);
    act(() => jest.advanceTimersByTime(REVEAL_MS));

    // Each option drops its entrance/pick motion (value, offset, scale, interpolation, transform, style, props): their
    // touch layers were never animated, so they have nothing to drop or read back (before: 80 nodes, 32 values)
    const OPTION_MOTION_NODES = 7;
    const OPTION_MOTION_VALUES = 3;
    const scores = nativeAnimatedOps(() => { showScores(); act(() => jest.advanceTimersByTime(SETTLE_MS)); });
    expect(scores.dropAnimatedNode).toBeLessThanOrEqual(PLAYER_COUNT * OPTION_MOTION_NODES);
    expect(scores.getValue).toBeLessThanOrEqual(PLAYER_COUNT * OPTION_MOTION_VALUES);
  });
});
