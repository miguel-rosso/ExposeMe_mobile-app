import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { getWinners, hasResult, rankScores } from "../src/utils/ranking";
import { ScoreRound } from "../src/models/interfaces";
import { TEST_IDS, finalRankId, finalWinnerId, scoreRankId, winnerNameId } from "../src/utils/testIds";
import WinnerModal from "../src/components/modals/WinnerModal";
import FinalScoreModal from "../src/components/modals/FinalScoreModal";
import ScoreModal from "../src/components/modals/ScoreModal";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-085 / DEC-013: tied players share the position (1, 1, 3) and every player tied
// for first is shown as a winner.

let mockT: typeof en | typeof es = en;
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock("lottie-react-native", () => "LottieView");
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("../src/providers/GameContext", () => ({
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

// ── No result (EXP-341 / DEC-044) ──
// A game where nobody scored (no rounds played, or everyone at 0) has no winner: no celebration, just the table.

describe("hasResult", () => {
  it("is true as soon as someone scored", () => {
    expect(hasResult([p("a", 0), p("b", 1)])).toBe(true);
    expect(hasResult([p("a", 10), p("b", 10)])).toBe(true);
  });

  it("is false when everyone is at 0 or there are no scores", () => {
    expect(hasResult([p("solo", 0)])).toBe(false);
    expect(hasResult([p("a", 0), p("b", 0)])).toBe(false);
    expect(hasResult([])).toBe(false);
  });
});

describe("FinalScoreModal without a result", () => {
  beforeEach(() => { jest.useFakeTimers(); mockT = en; });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  const texts = (root: ReactTestInstance) =>
    root.findAll((n) => (n.type as unknown) === "Text").map((n) => n.props.children);
  const confetti = (root: ReactTestInstance) => root.findAll((n) => (n.type as unknown) === "LottieView");

  it("titles it «No result», with no winner or confetti, and keeps the table and both buttons (en/es)", () => {
    let r = render(<FinalScoreModal visible finalScore={[sr("ana", 0), sr("bob", 0)]} />);
    expect(textOf(r.root, TEST_IDS.finalTitle)).toBe("No result");
    expect(texts(r.root)).toContain("Nobody scored any points");
    expect(confetti(r.root)).toHaveLength(0);
    expect(has(r.root, finalWinnerId("ana"))).toBe(false);
    expect(has(r.root, finalWinnerId("bob"))).toBe(false);
    expect(textOf(r.root, finalRankId("ana"))).toBe("1");
    expect(textOf(r.root, finalRankId("bob"))).toBe("1");
    expect(has(r.root, TEST_IDS.playAgainButton)).toBe(true);
    expect(has(r.root, TEST_IDS.finalExitButton)).toBe(true);
    act(() => r.unmount());

    mockT = es;
    r = render(<FinalScoreModal visible finalScore={[sr("ana", 0)]} />);
    expect(textOf(r.root, TEST_IDS.finalTitle)).toBe("Partida sin resultado");
    expect(texts(r.root)).toContain("Nadie ha sumado puntos");
    expect(confetti(r.root)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("a game with a winner or a tie keeps the title, the winners and the confetti", () => {
    for (const finalScore of [[sr("ana", 3), sr("bob", 0)], [sr("ana", 2), sr("bob", 2)]]) {
      const r = render(<FinalScoreModal visible finalScore={finalScore} />);
      expect(textOf(r.root, TEST_IDS.finalTitle)).toBe("Final Results");
      expect(confetti(r.root)).toHaveLength(1);
      expect(has(r.root, finalWinnerId("ana"))).toBe(true);
      act(() => r.unmount());
    }
  });
});
