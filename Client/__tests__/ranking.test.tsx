import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { getWinners, rankScores } from "../app/utils/ranking";
import { ScoreRound } from "../app/models/interfaces";
import { TEST_IDS, finalRankId, finalWinnerId, scoreRankId, winnerNameId } from "../app/utils/testIds";
import WinnerModal from "../app/components/modals/WinnerModal";
import FinalScoreModal from "../app/components/modals/FinalScoreModal";
import ScoreModal from "../app/components/modals/ScoreModal";
import en from "../app/i18n/en";
import es from "../app/i18n/es";

// EXP-085 / DEC-013: tied players share the position (1, 1, 3) and every player tied
// for first is shown as a winner.

let mockT: typeof en | typeof es = en;
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
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

const p = (username: string, points: number) => ({ username, points });
const ranks = (scores: { username: string; points: number }[]) =>
  rankScores(scores).map((s) => [s.username, s.rank]);

// ── Pure ranking ──

describe("rankScores / getWinners", () => {
  it("ties at the top share 1st and the next player is 3rd", () => {
    const scores = [p("c", 5), p("a", 10), p("b", 10)];
    expect(ranks(scores)).toEqual([["a", 1], ["b", 1], ["c", 3]]);
    expect(getWinners(scores).map((s) => s.username)).toEqual(["a", "b"]);
  });

  it("ties in the middle share the position and skip the next one", () => {
    expect(ranks([p("a", 30), p("b", 20), p("c", 20), p("d", 10)])).toEqual([["a", 1], ["b", 2], ["c", 2], ["d", 4]]);
    expect(getWinners([p("a", 30), p("b", 20), p("c", 20)]).map((s) => s.username)).toEqual(["a"]);
  });

  it("everyone tied is everyone 1st and everyone a winner", () => {
    const scores = [p("a", 7), p("b", 7), p("c", 7)];
    expect(ranks(scores)).toEqual([["a", 1], ["b", 1], ["c", 1]]);
    expect(getWinners(scores)).toHaveLength(3);
  });

  it("zero points for everyone is a tie too", () => {
    expect(getWinners([p("a", 0), p("b", 0)]).map((s) => s.rank)).toEqual([1, 1]);
    expect(ranks([p("a", 10), p("b", 0), p("c", 0)])).toEqual([["a", 1], ["b", 2], ["c", 2]]);
  });

  it("a single player is the only winner; no players means no winners", () => {
    expect(getWinners([p("solo", 3)])).toEqual([{ username: "solo", points: 3, rank: 1 }]);
    expect(getWinners([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const scores = [p("b", 1), p("a", 2)];
    rankScores(scores);
    expect(scores.map((s) => s.username)).toEqual(["b", "a"]);
  });
});

// ── Modals ──

const sr = (username: string, points: number): ScoreRound => ({
  username, points, isHost: false, lastAnswerCorrect: false, lastGuess: "",
});

const textOf = (root: ReactTestInstance, id: string) => {
  const found = root.findAll((n) => n.props.testID === id, { deep: true });
  if (!found.length) return null;
  const collect = (n: ReactTestInstance | string): string =>
    typeof n === "string" ? n : n.children.map(collect).join("");
  return collect(found[0]);
};
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

const render = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(el); });
  return r;
};

describe("tie rendering", () => {
  beforeEach(() => { jest.useFakeTimers(); mockT = en; });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("WinnerModal lists every tied winner under WINNERS! (en/es)", () => {
    const winners = getWinners([sr("ana", 20), sr("bob", 20), sr("cid", 10)]);
    let r = render(<WinnerModal visible winners={winners} onAnimationEnd={jest.fn()} />);
    expect(has(r.root, TEST_IDS.winnerModal)).toBe(true);
    expect(textOf(r.root, TEST_IDS.winnerTitle)).toBe("WINNERS!");
    expect(textOf(r.root, winnerNameId("ana"))).toBe("ana");
    expect(textOf(r.root, winnerNameId("bob"))).toBe("bob");
    expect(has(r.root, winnerNameId("cid"))).toBe(false);
    act(() => r.unmount());

    mockT = es;
    r = render(<WinnerModal visible winners={winners} onAnimationEnd={jest.fn()} />);
    expect(textOf(r.root, TEST_IDS.winnerTitle)).toBe("¡GANADORES!");
    act(() => r.unmount());
  });

  it("WinnerModal keeps the singular title for a single winner", () => {
    const r = render(<WinnerModal visible winners={getWinners([sr("ana", 20), sr("bob", 10)])} onAnimationEnd={jest.fn()} />);
    expect(textOf(r.root, TEST_IDS.winnerTitle)).toBe("WINNER!");
    expect(has(r.root, winnerNameId("bob"))).toBe(false);
    act(() => r.unmount());
  });

  it("FinalScoreModal highlights both tied winners and shows ranks 1, 1, 3", () => {
    const r = render(<FinalScoreModal visible finalScore={[sr("cid", 5), sr("ana", 20), sr("bob", 20)]} />);
    expect(has(r.root, finalWinnerId("ana"))).toBe(true);
    expect(has(r.root, finalWinnerId("bob"))).toBe(true);
    expect(has(r.root, finalWinnerId("cid"))).toBe(false);
    expect(textOf(r.root, finalRankId("ana"))).toBe("1");
    expect(textOf(r.root, finalRankId("bob"))).toBe("1");
    expect(textOf(r.root, finalRankId("cid"))).toBe("3");
    act(() => r.unmount());
  });

  it("ScoreModal shares the position between tied players", () => {
    const r = render(
      <ScoreModal visible scoreRound={[sr("ana", 20), sr("bob", 10), sr("cid", 10)]} rounds={{ round: 1, roundsOfGame: 3 }} correctAnswer="" />
    );
    expect(textOf(r.root, scoreRankId("ana"))).toBe("1");
    expect(textOf(r.root, scoreRankId("bob"))).toBe("2");
    expect(textOf(r.root, scoreRankId("cid"))).toBe("2");
    act(() => r.unmount());
  });
});
