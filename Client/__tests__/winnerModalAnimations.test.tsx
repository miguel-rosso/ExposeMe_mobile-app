import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { ScoreRound } from "../src/models/interfaces";
import { TEST_IDS, winnerNameId } from "../src/utils/testIds";
import WinnerModal, { WINNER_NAME_PULSES } from "../src/components/modals/WinnerModal";

// EXP-458: the winner overlay waits for a tap with no time limit, and its confetti looped forever (and the names
// pulsed forever): left alone on screen the app kept ~55% CPU. Every animation on it must end by itself.

jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("lottie-react-native", () => "LottieView");
let mockReduceMotion = false;
jest.mock("../src/hooks/useReduceMotion", () => ({ useReduceMotion: () => mockReduceMotion }));

const CONFETTI = require("../assets/animations/confetiAnimation.json");
// The title fades in (1 s) and the overlay waits 3.5 s more before it offers "tap to continue"
const UNTIL_TAP_TO_CONTINUE_MS = 5000;

const winners: ScoreRound[] = [{ username: "Ana", points: 7, isHost: true, lastAnswerCorrect: true, lastGuess: "Bea" }];

beforeEach(() => {
  jest.useFakeTimers();
  mockReduceMotion = false;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const render = () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<WinnerModal visible winners={winners} onAnimationEnd={jest.fn()} />); });
  return r;
};
const confettiOf = (root: ReactTestInstance) => root.findAll((n) => n.props.source === CONFETTI && typeof n.type === "string");
const byId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id)[0];
const waitForTapToContinue = () => act(() => { jest.advanceTimersByTime(UNTIL_TAP_TO_CONTINUE_MS); });

describe("WinnerModal animations end by themselves (EXP-458)", () => {
  it("plays the confetti once and removes it when the burst ends", () => {
    const r = render();
    const [confetti] = confettiOf(r.root);
    expect(confetti.props.loop).toBe(false);

    act(() => confetti.props.onAnimationFinish(false));
    expect(confettiOf(r.root)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("brings the confetti back for the next game's winner screen", () => {
    const r = render();
    act(() => confettiOf(r.root)[0].props.onAnimationFinish(false));
    act(() => r.update(<WinnerModal visible={false} winners={winners} onAnimationEnd={jest.fn()} />));
    act(() => r.update(<WinnerModal visible winners={winners} onAnimationEnd={jest.fn()} />));
    expect(confettiOf(r.root)).toHaveLength(1);
    act(() => r.unmount());
  });

  it("pulses the winner's name a fixed number of times once the overlay waits for the tap", () => {
    const r = render();
    waitForTapToContinue();
    expect(byId(r.root, TEST_IDS.winnerContinue)).toBeDefined();
    const name = byId(r.root, winnerNameId("Ana"));
    expect(name.props.animation).toBe("pulse");
    expect(name.props.iterationCount).toBe(WINNER_NAME_PULSES);
    expect(Number.isFinite(WINNER_NAME_PULSES)).toBe(true);
    act(() => r.unmount());
  });

  it("shows no confetti and no pulse when the system asks to reduce motion", () => {
    mockReduceMotion = true;
    const r = render();
    expect(confettiOf(r.root)).toHaveLength(0);
    waitForTapToContinue();
    expect(byId(r.root, TEST_IDS.winnerContinue)).toBeDefined();
    expect(byId(r.root, winnerNameId("Ana")).props.animation).toBeUndefined();
    act(() => r.unmount());
  });
});
