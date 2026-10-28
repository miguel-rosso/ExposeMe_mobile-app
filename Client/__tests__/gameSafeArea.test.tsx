import React from "react";
import { StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import EmojiReactionLane from "../app/components/IngameComunication/EmojiReactionLane";
import EmojisButton from "../app/components/IngameComunication/EmojisButtons";
import ScoreModal, { HOLD_BUTTON_CLEARANCE } from "../app/components/modals/ScoreModal";
import { ANSWERS_BOTTOM, EMOJI_ROW_BOTTOM, HOLD_BUTTON_BOTTOM } from "../app/utils/gameRows";

// EXP-205: the rows laid over the game photo (timer bar, reactions, answers, emoji row, hold button, reconnecting
// banner) and the round scoreboard keep clear of the notch, the Dynamic Island, the home indicator and the navigation
// bar. Without any of them (zero insets) nothing moves. The top offsets already cleared a status bar: only a taller
// cutout pushes a top row down, to just below it (never by the whole inset on top of the old offset).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

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
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
// iPhone with Dynamic Island, portrait; and a landscape phone with the notch on the left
const ISLAND_INSETS = { top: 59, bottom: 34, left: 0, right: 0 };
// Android phone with a plain status bar and gesture navigation
const STATUS_BAR_INSETS = { top: 24, bottom: 16, left: 0, right: 0 };
const LANDSCAPE_INSETS = { top: 0, bottom: 21, left: 47, right: 47 };
const withInsets = (insets: typeof NO_INSETS, el: React.ReactElement) => (
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets }}>{el}</SafeAreaProvider>
);

type Box = { top?: number; bottom?: number; left?: number; right?: number; paddingTop?: number; paddingBottom?: number };
const flat = (n: ReactTestInstance) => (StyleSheet.flatten(n.props.style) ?? {}) as Box;
const byId = (root: ReactTestInstance, id: string) =>
  root.find((n) => n.props.testID === id && typeof n.type === "string");
// Nearest ancestor placed with an explicit offset from that edge
const placedAncestor = (n: ReactTestInstance, edge: "top" | "bottom") => {
  let node: ReactTestInstance | null = n;
  while (node && typeof flat(node)[edge] !== "number") node = node.parent;
  return flat(node!);
};

// ── Game screen rows ──
const playRoundToScores = async (insets: typeof NO_INSETS) => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(withInsets(insets, <GameScreen />)); });
  act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }));
  return r;
};

describe("GameScreen rows keep clear of the screen's unsafe edges (EXP-205)", () => {
  beforeEach(() => { jest.useFakeTimers(); mockSocket.reset(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  const rowsOf = async (insets: typeof NO_INSETS) => {
    const r = await playRoundToScores(insets);
    const progress = flat(byId(r.root, TEST_IDS.roundProgress));
    const answers = placedAncestor(byId(r.root, TEST_IDS.answerOptions), "bottom");
    const laneTop = r.root.findByType(EmojiReactionLane).props.top as number;
    act(() => { mockSocket.connected = false; mockSocket.fire("disconnect", "transport close"); });
    const banner = flat(byId(r.root, TEST_IDS.reconnectingBanner));
    act(() => { mockSocket.connected = true; });
    // My photo: the hold button shows in scores
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    const hold = placedAncestor(byId(r.root, TEST_IDS.holdButton), "bottom");
    act(() => r.unmount());
    return { progress, answers, laneTop, banner, hold };
  };

  it("without notch nor home indicator, every row stays at its usual place", async () => {
    const rows = await rowsOf(NO_INSETS);
    expect(rows.progress).toMatchObject({ top: 60, left: 0, right: 0 });
    expect(rows.laneTop).toBe(100);
    expect(rows.answers).toMatchObject({ bottom: 88, left: 0, right: 0 });
    expect(rows.banner).toMatchObject({ top: 8, left: 0, right: 0 });
    expect(rows.hold).toMatchObject({ bottom: 96, left: 0, right: 0 });
  });

  it("with a Dynamic Island, the top rows sit just below it; with a home indicator, the bottom rows above it", async () => {
    const rows = await rowsOf(ISLAND_INSETS);
    expect(rows.progress.top).toBe(Math.max(60, 59 + 4));
    expect(rows.laneTop).toBe(rows.progress.top! + 40);
    expect(rows.banner.top).toBe(Math.max(8, 59 + 8));
    expect(rows.answers.bottom).toBe(88 + 34);
    expect(rows.hold.bottom).toBe(96 + 34);
  });

  it("with a plain status bar, the top rows that already cleared it stay put", async () => {
    const rows = await rowsOf(STATUS_BAR_INSETS);
    expect(rows.progress.top).toBe(60);
    expect(rows.laneTop).toBe(100);
    expect(rows.banner.top).toBe(24 + 8);
    expect(rows.answers.bottom).toBe(88 + 16);
  });

  it("stacks the bottom rows from the emoji row up (hold button on it, answers' buttons level with it)", () => {
    expect(HOLD_BUTTON_BOTTOM).toBe(96);
    expect(ANSWERS_BOTTOM).toBe(88);
    expect(HOLD_BUTTON_CLEARANCE).toBe(176);
  });

  it("in landscape, the full-width rows stay out of the side notch", async () => {
    const rows = await rowsOf(LANDSCAPE_INSETS);
    for (const row of [rows.progress, rows.answers, rows.banner, rows.hold]) {
      expect(row).toMatchObject({ left: 47, right: 47 });
    }
  });
});

// ── Emoji row ──
jest.mock("expo-screen-capture", () => ({ addScreenshotListener: () => ({ remove: jest.fn() }) }));

describe("Emoji row (EXP-205)", () => {
  const rowOf = (insets: typeof NO_INSETS) => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(withInsets(insets, <EmojisButton />)); });
    const row = placedAncestor(r.root.findAll((n) => typeof n.props.onPress === "function")[0], "bottom");
    act(() => r.unmount());
    return row;
  };

  it("sits above the home indicator / navigation bar, and where it was without them", () => {
    expect(rowOf(NO_INSETS)).toMatchObject({ bottom: EMOJI_ROW_BOTTOM, left: 0, right: 0 });
    expect(EMOJI_ROW_BOTTOM).toBe(48);
    expect(rowOf(ISLAND_INSETS).bottom).toBe(EMOJI_ROW_BOTTOM + 34);
    expect(rowOf(LANDSCAPE_INSETS)).toMatchObject({ left: 47, right: 47 });
  });
});

// ── Round scoreboard ──
describe("Round scoreboard (EXP-205)", () => {
  const SCORES = mockPlayers.map((p) => ({ ...p, isHost: false }));
  const layoutOf = (insets: typeof NO_INSETS, reserveHoldButton: boolean) => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(withInsets(insets, (
        <ScoreModal
          visible
          scoreRound={SCORES}
          rounds={{ round: 1, roundsOfGame: 10 }}
          correctAnswer=""
          reserveHoldButton={reserveHoldButton}
        />
      )));
    });
    const modal = flat(byId(r.root, TEST_IDS.scoreModal));
    const title = flat(byId(r.root, TEST_IDS.scoreRoundTitle));
    act(() => r.unmount());
    return { modal, title };
  };

  it("keeps its title and list clear of the notch and the home indicator", () => {
    expect(layoutOf(NO_INSETS, false)).toMatchObject({ modal: { paddingTop: 80, paddingBottom: 64 }, title: { top: 40 } });
    // The title moves just below the island and the list keeps its space under the title
    expect(layoutOf(ISLAND_INSETS, false)).toMatchObject({
      modal: { paddingTop: 59 + 8 + 40, paddingBottom: 64 + 34 }, title: { top: 59 + 8 },
    });
    expect(layoutOf(STATUS_BAR_INSETS, false)).toMatchObject({ modal: { paddingTop: 80 }, title: { top: 40 } });
    // The owner's hold button moved up by the bottom inset: the space kept for it too
    expect(layoutOf(ISLAND_INSETS, true).modal.paddingBottom).toBe(HOLD_BUTTON_CLEARANCE + 34);
  });
});
