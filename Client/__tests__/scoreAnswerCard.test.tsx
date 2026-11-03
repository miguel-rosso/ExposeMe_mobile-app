import React, { Profiler } from "react";
import { AccessibilityInfo, NativeModules } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { ScoreRound } from "../src/models/interfaces";
import { TEST_IDS, scoreGuessId } from "../src/utils/testIds";
import { getWinners } from "../src/utils/ranking";
import ScoreModal from "../src/components/modals/ScoreModal";
import WinnerModal from "../src/components/modals/WinnerModal";
import FinalScoreModal from "../src/components/modals/FinalScoreModal";
import { resetReduceMotionSettingForTests, useReduceMotion } from "../src/hooks/useReduceMotion";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-252: the round scoreboard shows whose photo it was in a highlighted card with the name in large type; the
// owner (who only learns it here) gets "It was your photo!" instead. The owner votes like everyone, so their row shows
// their guess like any other; a player who didn't answer gets the translated "No guess" (the server sends "").
// EXP-120: "1 point" singular in WinnerModal.

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

const sr = (username: string, points: number, lastGuess = "", lastAnswerCorrect = false): ScoreRound => ({
  username, points, isHost: false, lastAnswerCorrect, lastGuess,
});

// ana owns the photo and didn't recognise it (guessed cid); bob guessed right, cid guessed wrong, dan didn't answer
const scores = [sr("ana", 1, "cid"), sr("bob", 2, "ana", true), sr("cid", 0, "bob"), sr("dan", 0)];

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

const byId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id && typeof n.type === "string");

beforeEach(() => { mockT = en; });

describe("ScoreModal: whose photo it was (EXP-252)", () => {
  // The card's entrance animation runs on timers
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("shows the owner's name large in a highlighted card", () => {
    const r = modal("bob");
    const [card] = byId(r.root, TEST_IDS.scoreAnswerCard);
    expect(collect(card)).toContain(en.photoWasFrom);
    expect(collect(byId(card, TEST_IDS.scoreAnswerName)[0])).toBe("ana");
    expect(allText(r.root)).not.toContain(en.itWasYourPhoto);
    act(() => r.unmount());
  });

  it("tells the owner it was their photo (they only learn it now)", () => {
    const r = modal("ana");
    const [card] = byId(r.root, TEST_IDS.scoreAnswerCard);
    expect(collect(byId(card, TEST_IDS.scoreAnswerName)[0])).toBe(en.itWasYourPhoto);
    expect(collect(card)).not.toContain(en.photoWasFrom);
    act(() => r.unmount());
  });

  it("is translated (en/es)", () => {
    mockT = es;
    let r = modal("bob");
    expect(collect(byId(r.root, TEST_IDS.scoreAnswerCard)[0])).toContain(es.photoWasFrom);
    act(() => r.unmount());
    r = modal("ana");
    expect(collect(byId(r.root, TEST_IDS.scoreAnswerName)[0])).toBe("¡Era tu foto!");
    act(() => r.unmount());
    expect(es.photoWasFrom).not.toBe(en.photoWasFrom);
    expect(es.itWasYourPhoto).not.toBe(en.itWasYourPhoto);
  });

  it("a long name fits on one line, shrinking instead of wrapping (small phones)", () => {
    const r = render(<ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="ana" myUsername="bob" />);
    const name = byId(r.root, TEST_IDS.scoreAnswerName)[0];
    expect(name.props.numberOfLines).toBe(1);
    expect(name.props.adjustsFontSizeToFit).toBe(true);
    act(() => r.unmount());
  });

  it("without a known answer there is no card", () => {
    const r = render(<ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="" myUsername="ana" />);
    expect(byId(r.root, TEST_IDS.scoreAnswerCard)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("the owner's row shows their guess like anyone's; 'No guess' is translated (en/es)", () => {
    let r = modal("bob");
    expect(row(r.root, "ana")).toEqual({ label: "cid", icon: "times-circle", color: "red" });
    expect(row(r.root, "bob")).toEqual({ label: "ana", icon: "check-circle", color: "green" });
    expect(row(r.root, "cid")).toEqual({ label: "bob", icon: "times-circle", color: "red" });
    expect(row(r.root, "dan")).toEqual({ label: "No guess", icon: "times-circle", color: "red" });
    expect(allText(r.root)).not.toContain("(no guess)");
    act(() => r.unmount());

    mockT = es;
    r = modal("ana");
    expect(row(r.root, "dan").label).toBe("Sin respuesta");
    expect(row(r.root, "ana").label).toBe("cid");
    act(() => r.unmount());
  });
});

// EXP-311: the scoreboard is painted from its first commit; the card's entrance must not add a second one before it
describe("ScoreModal: the owner card's entrance (EXP-311)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("mounts in one commit and bounces in on the native driver, without re-rendering", () => {
    const startAnimation = NativeModules.NativeAnimatedModule.startAnimatingNode as jest.Mock;
    startAnimation.mockClear();
    const commits: string[] = [];
    const r = render(
      <Profiler id="scores" onRender={(_id, phase) => { commits.push(phase); }}>
        <ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="ana" myUsername="bob" />
      </Profiler>,
    );
    expect(commits).toEqual(["mount"]);
    expect(startAnimation).toHaveBeenCalledTimes(1);
    // It starts small and transparent, and the whole bounce runs natively: no frame comes back through React
    const [card] = byId(r.root, TEST_IDS.scoreAnswerCard);
    expect(card.props.style).toEqual(expect.objectContaining({ opacity: 0, transform: [{ scale: 0.3 }] }));
    act(() => jest.advanceTimersByTime(1_000));
    expect(commits).toEqual(["mount"]);
    act(() => r.unmount());
  });
});

// EXP-314: with iOS Reduce Motion / Android Remove animations on, the card appears without bouncing in. The setting is
// cached app-wide once the system answers (EXP-315), so the card reads it on its first frame however the scoreboard
// mounts: hidden during the round and then shown, or already visible (after a hold is released, or rejoining in scores).
describe("ScoreModal: the owner card with reduce motion on (EXP-314)", () => {
  let onSettingChange: ((enabled: boolean) => void) | undefined;
  const startAnimation = () => NativeModules.NativeAnimatedModule.startAnimatingNode as jest.Mock;
  const fullSize = expect.objectContaining({ opacity: 1, transform: [{ scale: 1 }] });
  const cardStyle = (r: TestRenderer.ReactTestRenderer) => byId(r.root, TEST_IDS.scoreAnswerCard)[0].props.style;

  beforeEach(() => {
    jest.useFakeTimers();
    resetReduceMotionSettingForTests();
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((_: string, fn: (enabled: boolean) => void) => {
      onSettingChange = fn;
      return { remove: jest.fn() };
    }) as unknown as typeof AccessibilityInfo.addEventListener);
  });
  afterEach(() => {
    resetReduceMotionSettingForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const phases: string[] = [];
  const scoreboard = (visible: boolean) => (
    <Profiler id="scores" onRender={(_id, phase) => { phases.push(phase); }}>
      <ScoreModal visible={visible} scoreRound={scores} rounds={{ round: 1, roundsOfGame: 10 }} correctAnswer="ana" myUsername="bob" />
    </Profiler>
  );
  beforeEach(() => { phases.length = 0; });

  it("shown after being hidden during the round: full opacity and size from the first frame, no animation", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(scoreboard(false)); });
    startAnimation().mockClear();
    phases.length = 0;

    act(() => r.update(scoreboard(true)));
    expect(phases).toEqual(["update"]);
    expect(cardStyle(r)).toEqual(fullSize);
    expect(startAnimation()).not.toHaveBeenCalled();

    // Turning the setting off while the scoreboard is up doesn't bounce the card in late
    act(() => onSettingChange!(false));
    act(() => jest.advanceTimersByTime(1_000));
    expect(startAnimation()).not.toHaveBeenCalled();
    expect(cardStyle(r)).toEqual(fullSize);
    act(() => r.unmount());
  });

  it("mounted already visible (hold released, rejoin in scores): full opacity and size from the first frame", async () => {
    // The game screen asked first, earlier in the game, and the system answered
    const EarlierConsumer = () => { useReduceMotion(); return null; };
    let game!: TestRenderer.ReactTestRenderer;
    await act(async () => { game = TestRenderer.create(<EarlierConsumer />); });
    startAnimation().mockClear();

    const r = render(scoreboard(true));
    expect(phases).toEqual(["mount"]);
    expect(cardStyle(r)).toEqual(fullSize);
    act(() => jest.advanceTimersByTime(1_000));
    expect(startAnimation()).not.toHaveBeenCalled();
    expect(phases).toEqual(["mount"]);
    act(() => { r.unmount(); game.unmount(); });
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
