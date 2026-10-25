import React from "react";
import { StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { ScoreRound } from "../app/models/interfaces";
import { TEST_IDS, finalRankId, scoreRankId } from "../app/utils/testIds";
import ScoreModal, { HOLD_BUTTON_CLEARANCE } from "../app/components/modals/ScoreModal";
import FinalScoreModal from "../app/components/modals/FinalScoreModal";

// EXP-043: with up to 12 players the round scoreboard needs ~670 dp. The list must scroll inside the space left
// between the header and the hold button (photo owner), so nothing is cut on small phones.

jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("lottie-react-native", () => "LottieView");
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    endSocket: jest.fn(), setRoundsOfGame: jest.fn(), setPlayersProvider: jest.fn(), clearRejoinToken: jest.fn(),
  }),
}));

const NAMES = Array.from({ length: 12 }, (_, i) => `player${i + 1}`);
const scores: ScoreRound[] = NAMES.map((username, i) => ({
  username, points: 100 - i * 5, isHost: i === 0, lastAnswerCorrect: i % 2 === 0, lastGuess: "player1",
}));

const render = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(el); });
  return r;
};
const byId = (root: ReactTestInstance, id: string) => root.find((n) => n.props.testID === id && typeof n.type === "string");
const inside = (container: ReactTestInstance, id: string) =>
  container.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const scrollHost = (n: ReactTestInstance) => (n.type as unknown) === "RCTScrollView";

describe("ScoreModal with 12 players (EXP-043)", () => {
  it("renders every row inside a scroll view, header and answer outside it", () => {
    const r = render(
      <ScoreModal visible scoreRound={scores} rounds={{ round: 3, roundsOfGame: 10 }} correctAnswer="player1" />
    );
    const list = byId(r.root, TEST_IDS.scoreList);
    expect(scrollHost(list)).toBe(true);
    for (const name of NAMES) expect(inside(list, scoreRankId(name))).toBe(true);
    // Round title and "it was X's photo" stay fixed above the list
    expect(inside(list, TEST_IDS.scoreRoundTitle)).toBe(false);
    expect(inside(r.root, TEST_IDS.scoreRoundTitle) && inside(r.root, TEST_IDS.scoreAnswerPill)).toBe(true);
    expect(inside(list, TEST_IDS.scoreAnswerPill)).toBe(false);
    // The list may only shrink (never grow past its content) so the header stays on screen
    expect(StyleSheet.flatten(list.props.style).flexGrow).toBe(0);
    act(() => r.unmount());
  });

  const bottomPadding = (reserveHoldButton: boolean) => {
    const r = render(
      <ScoreModal visible scoreRound={scores} rounds={{ round: 3, roundsOfGame: 10 }} correctAnswer="" reserveHoldButton={reserveHoldButton} />
    );
    const pb = StyleSheet.flatten(byId(r.root, TEST_IDS.scoreModal).props.style).paddingBottom;
    act(() => r.unmount());
    return pb;
  };

  it("leaves room for the hold button below the list when it is shown (photo owner)", () => {
    expect(bottomPadding(true)).toBe(HOLD_BUTTON_CLEARANCE);
    // Hold button: bottom-24 (96) + p-4 and a text-lg line (~64)
    expect(HOLD_BUTTON_CLEARANCE).toBeGreaterThanOrEqual(160);
  });

  it("keeps the usual bottom margin when there is no hold button", () => {
    expect(bottomPadding(false)).toBe(64);
  });
});

describe("FinalScoreModal with 12 players", () => {
  it("scrolls the ranking and keeps both buttons outside the list", () => {
    jest.useFakeTimers();
    const r = render(<FinalScoreModal visible finalScore={scores} />);
    const lists = r.root.findAll((n) => scrollHost(n) && inside(n, finalRankId("player1")));
    expect(lists).toHaveLength(1);
    expect(inside(lists[0], TEST_IDS.finalExitButton)).toBe(false);
    expect(inside(lists[0], TEST_IDS.playAgainButton)).toBe(false);
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
