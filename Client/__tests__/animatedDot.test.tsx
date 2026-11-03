import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Animated } from "react-native";
import AnimatedDot, { DOT_CYCLE_MS, DOT_LIFT, hopThereAndBack } from "../src/components/AnimatedDot";

// EXP-396: the lobby's "waiting…" dots hop forever: the loop runs on the native driver, so the JS thread does nothing
// per frame (react-native-animatable drove every frame, and every iteration, from JS).

const DELAY_MS = 400;

let timingSpy: jest.SpyInstance;
let loopSpy: jest.SpyInstance;
let delaySpy: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  timingSpy = jest.spyOn(Animated, "timing");
  loopSpy = jest.spyOn(Animated, "loop");
  delaySpy = jest.spyOn(Animated, "delay");
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const renderDot = (delay?: number) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<AnimatedDot delay={delay} />); });
  return r;
};
/** The dot's lift as rendered: the interpolation on its translateY */
const dotLift = (r: TestRenderer.ReactTestRenderer) => {
  const style = r.root.findByType(Animated.Text).props.style as unknown[];
  const { transform } = style[1] as { transform: { translateY: { __getValue: () => number } }[] };
  return transform[0].translateY;
};

describe("AnimatedDot (EXP-396)", () => {
  it("loops its hop on the native driver, after its delay", () => {
    const r = renderDot(DELAY_MS);
    expect(delaySpy).toHaveBeenCalledWith(DELAY_MS);
    expect(timingSpy).toHaveBeenCalledTimes(1);
    expect(timingSpy.mock.calls[0][1]).toMatchObject({ toValue: 1, duration: DOT_CYCLE_MS, useNativeDriver: true });
    // A loop of a native-driver animation runs natively (no JS restart per iteration), forever
    expect(loopSpy).toHaveBeenCalledTimes(1);
    const [looped, loopConfig] = loopSpy.mock.calls[0];
    expect(looped._isUsingNativeDriver()).toBe(true);
    expect(loopConfig?.iterations ?? -1).toBe(-1);
    act(() => r.unmount());
  });

  it("stops its animation when it leaves the screen", () => {
    const sequenceSpy = jest.spyOn(Animated, "sequence");
    const r = renderDot(DELAY_MS);
    const animation = sequenceSpy.mock.results[0].value as Animated.CompositeAnimation;
    const stopSpy = jest.spyOn(animation, "stop");
    act(() => r.unmount());
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("hops like before: up by 40% of the first second, back down by 80%, then the same hop mirrored", () => {
    // Still in its delay: the hop value is not driven yet, so it can be set to read the curve
    const r = renderDot(DELAY_MS);
    const hop = timingSpy.mock.calls[0][0] as Animated.Value;
    const liftAt = (cycleProgress: number) => {
      hop.setValue(hopThereAndBack(cycleProgress));
      return dotLift(r).__getValue();
    };

    expect(liftAt(0)).toBeCloseTo(0);
    expect(liftAt(1)).toBeCloseTo(0);
    expect(liftAt(0.5)).toBeCloseTo(0); // the end of the hop (and the start of its mirror): still
    // Highest when the eased hop is at 40%: on the way there, and at the same time from the end on the way back
    const highest = Math.min(...Array.from({ length: 101 }, (_, i) => liftAt(i / 100)));
    expect(highest).toBeCloseTo(-DOT_LIFT, 0);
    for (const p of [0.1, 0.2, 0.3, 0.4]) expect(liftAt(p)).toBeCloseTo(liftAt(1 - p));
    act(() => r.unmount());
  });

  it("is the same text dot as before", () => {
    const r = renderDot();
    expect(r.root.findByType(Animated.Text).props.children).toBe(".");
    act(() => r.unmount());
  });
});
