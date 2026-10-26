import React, { Profiler } from "react";
import { Platform } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { TEST_IDS, emojiButtonId } from "../app/utils/testIds";
import { honourNativeAnimationDurations } from "../testUtils/nativeAnimations";

// EXP-225: Androids painted the answering phase 350-430 ms (p50) after its round-start handler ran, iPhones in ~30 ms.
// This measures what GameScreen renders and commits on the round-start transition, with the Android photo layer and the
// real progress bar, answer options and emoji buttons, and pins the cheaper mount down.

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
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
// Every render of an answer option (each one asks for its testID once per render), and of the emoji buttons
const mockOptionRenders = { count: 0 };
const mockEmojiButtonsRenders = { count: 0 };
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => {
  const ActualEmojisButton = jest.requireActual("@/app/components/IngameComunication/EmojisButtons").default;
  return () => {
    mockEmojiButtonsRenders.count++;
    return require("react").createElement(ActualEmojisButton);
  };
});
jest.mock("../app/utils/testIds", () => {
  const actual = jest.requireActual("../app/utils/testIds");
  return {
    ...actual,
    playerOptionId: (name: string) => { mockOptionRenders.count++; return actual.playerOptionId(name); },
  };
});

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
  const onRender = () => { commits.push({ options: mockOptionRenders.count, emojiButtons: mockEmojiButtonsRenders.count }); };
  const resetCounts = () => { commits = []; mockOptionRenders.count = 0; mockEmojiButtonsRenders.count = 0; };
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
    // Measuring the options' top (for the reaction lane) re-renders the screen once, but no option
    expect(mockOptionRenders.count).toBe(PLAYER_COUNT);
    expect(commits.length).toBeLessThanOrEqual(4);
    // The backdrop comes with the loaded photo (EXP-131): one commit of the photo alone, no option re-rendered
    const commitsBeforeLoad = commits.length;
    photoLoaded();
    expect(blurredImages(r.root)).toHaveLength(1);
    expect(commits).toHaveLength(commitsBeforeLoad + 1);
    expect(mockOptionRenders.count).toBe(PLAYER_COUNT);

    // Later rounds: the options' top is already known, the layout pass costs no commit of the screen
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    resetCounts();
    startRound(2);
    layOut(laidOut);
    expect(mockOptionRenders.count).toBe(PLAYER_COUNT);
    expect(commits.length).toBeLessThanOrEqual(3);
  });

  it("re-renders only the option I pick", () => {
    startRound(1);
    layOut(new Set());
    resetCounts();
    const option = r.root.find((n) => n.props.testID === "player-option-player3" && typeof n.props.onPress === "function");
    act(() => option.props.onPress());
    expect(mockOptionRenders.count).toBe(1);
    expect(mockSocket.emitted).toContainEqual(["submit-answer", { guess: "player3" }]);
  });
});
