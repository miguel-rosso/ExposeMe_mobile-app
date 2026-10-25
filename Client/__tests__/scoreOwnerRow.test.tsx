import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { ScoreRound } from "../app/models/interfaces";
import { scoreGuessId } from "../app/utils/testIds";
import { getWinners } from "../app/utils/ranking";
import ScoreModal from "../app/components/modals/ScoreModal";
import WinnerModal from "../app/components/modals/WinnerModal";
import FinalScoreModal from "../app/components/modals/FinalScoreModal";
import en from "../app/i18n/en";
import es from "../app/i18n/es";

// EXP-132: the photo owner doesn't vote, so their scoreboard row is neutral ("Their photo" / "Your photo"), not a
// red X with "No guess"; a player who didn't answer gets the translated "No guess" (the server sends "").
// EXP-120: "1 point" singular in WinnerModal.

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

const sr = (username: string, points: number, lastGuess = "", lastAnswerCorrect = false): ScoreRound => ({
  username, points, isHost: false, lastAnswerCorrect, lastGuess,
});

// ana owns the photo; bob guessed right, cid guessed wrong, dan didn't answer
const scores = [sr("ana", 1), sr("bob", 2, "ana", true), sr("cid", 0, "bob"), sr("dan", 0)];

const render = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(el); });
  return r;
};
const collect = (n: ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(collect).join(""));
const row = (root: ReactTestInstance, username: string) => {
  const text = root.find((n) => n.props.testID === scoreGuessId(username) && typeof n.type === "string");
  let box = text.parent!;
  while (!box.findAll((n) => (n.type as unknown) === "Icon").length) box = box.parent!;
  const icon = box.findAll((n) => (n.type as unknown) === "Icon")[0];
  return { label: collect(text), icon: icon.props.name as string, color: icon.props.color as string };
};
const allText = (root: ReactTestInstance) => collect(root);
const modal = (myUsername: string) =>
  render(<ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="ana" myUsername={myUsername} />);

beforeEach(() => { mockT = en; });

describe("ScoreModal owner row (EXP-132)", () => {
  it("shows the owner as 'Their photo' with a neutral icon, never a red X", () => {
    const r = modal("bob");
    expect(row(r.root, "ana")).toEqual({ label: "Their photo", icon: "camera", color: "gray" });
    expect(row(r.root, "bob")).toEqual({ label: "ana", icon: "check-circle", color: "green" });
    expect(row(r.root, "cid")).toEqual({ label: "bob", icon: "times-circle", color: "red" });
    act(() => r.unmount());
  });

  it("shows 'Your photo' on the owner's own device", () => {
    const r = modal("ana");
    expect(row(r.root, "ana").label).toBe("Your photo");
    act(() => r.unmount());
  });

  it("a player who didn't answer gets the translated 'No guess' (en/es), never '(no guess)'", () => {
    let r = modal("bob");
    expect(row(r.root, "dan")).toEqual({ label: "No guess", icon: "times-circle", color: "red" });
    expect(allText(r.root)).not.toContain("(no guess)");
    act(() => r.unmount());

    mockT = es;
    r = modal("ana");
    expect(row(r.root, "dan").label).toBe("Sin respuesta");
    expect(row(r.root, "ana").label).toBe("Tu foto");
    act(() => r.unmount());
    r = modal("bob");
    expect(row(r.root, "ana").label).toBe("Su foto");
    act(() => r.unmount());
  });

  it("without a known answer nobody is shown as the owner", () => {
    const r = render(<ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="" myUsername="ana" />);
    expect(row(r.root, "ana").label).toBe("No guess");
    act(() => r.unmount());
  });
});

describe("end of game texts", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("FinalScoreModal shows no guess placeholder", () => {
    const r = render(<FinalScoreModal visible finalScore={scores} />);
    expect(allText(r.root)).not.toMatch(/no guess/i);
    act(() => r.unmount());
  });

  it("WinnerModal uses the singular for 1 point (EXP-120, en/es) and the plural otherwise", () => {
    let r = render(<WinnerModal visible winners={getWinners([sr("ana", 1), sr("bob", 0)])} onAnimationEnd={jest.fn()} />);
    expect(allText(r.root)).toContain("1 point");
    expect(allText(r.root)).not.toContain("1 points");
    act(() => r.unmount());

    mockT = es;
    r = render(<WinnerModal visible winners={getWinners([sr("ana", 1), sr("bob", 0)])} onAnimationEnd={jest.fn()} />);
    expect(allText(r.root)).toContain("1 punto");
    expect(allText(r.root)).not.toContain("1 puntos");
    act(() => r.unmount());

    r = render(<WinnerModal visible winners={getWinners([sr("ana", 3), sr("bob", 0)])} onAnimationEnd={jest.fn()} />);
    expect(allText(r.root)).toContain("3 puntos");
    act(() => r.unmount());
  });
});
