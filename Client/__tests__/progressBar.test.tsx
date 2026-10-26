import React, { Profiler } from "react";
import { Animated, StyleSheet } from "react-native";
import TestRenderer, { act } from "react-test-renderer";
import ProgressBar from "../app/components/ProgressBar";
import { honourNativeAnimationDurations } from "../testUtils/nativeAnimations";

// EXP-175 / EXP-225: the bar animated its width on the JS thread, a layout pass and a JS frame of work for the whole
// phase, on every device. It now scales its fill with a transform on the native driver.

describe("ProgressBar", () => {
  beforeEach(() => { jest.useFakeTimers(); honourNativeAnimationDurations(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  const fill = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => typeof n.type === "string")[1];

  it("runs on the native driver and scales a full-width fill from its left edge", () => {
    const timing = jest.spyOn(Animated, "timing");
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ProgressBar duration={8_000} />); });
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 8_000, useNativeDriver: true }));
    const style = StyleSheet.flatten(fill(r).props.style);
    expect(style.width).toBe("100%");
    expect(style.transformOrigin).toBe("left");
    expect(style.transform).toEqual([{ scaleX: 0 }]);
    act(() => r.unmount());
  });

  it("calls onEnd once, when the server's duration has run out, without re-rendering meanwhile", () => {
    const onEnd = jest.fn();
    let commits = 0;
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <Profiler id="bar" onRender={() => { commits++; }}><ProgressBar duration={8_000} onEnd={onEnd} /></Profiler>,
      );
    });
    commits = 0;
    act(() => jest.advanceTimersByTime(7_900));
    expect(onEnd).not.toHaveBeenCalled();
    expect(commits).toBe(0);
    act(() => jest.advanceTimersByTime(200));
    expect(onEnd).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  // EXP-185: GameScreen passes a new onEnd on every render; the real bar must still fill once and call onEnd once
  it("re-renders with a new onEnd neither restarts the bar nor call onEnd twice, before or after it fills", () => {
    const firstOnEnd = jest.fn();
    const latestOnEnd = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ProgressBar duration={8_000} onEnd={firstOnEnd} />); });
    act(() => jest.advanceTimersByTime(5_000));
    act(() => r.update(<ProgressBar duration={8_000} onEnd={latestOnEnd} />));
    act(() => jest.advanceTimersByTime(3_100));
    expect(firstOnEnd).not.toHaveBeenCalled();
    expect(latestOnEnd).toHaveBeenCalledTimes(1);

    act(() => r.update(<ProgressBar duration={8_000} onEnd={latestOnEnd} />));
    act(() => jest.advanceTimersByTime(20_000));
    expect(latestOnEnd).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  // EXP-080 / EXP-099: a resumed phase starts at the fraction already gone and fills in what is left
  it("starts at the elapsed fraction and fills the rest in the server's remaining duration", () => {
    const timing = jest.spyOn(Animated, "timing");
    const onEnd = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ProgressBar duration={2_000} elapsed={0.75} onEnd={onEnd} />); });
    expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 0.75 }]);
    expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, duration: 2_000 }));
    act(() => jest.advanceTimersByTime(1_900));
    expect(onEnd).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(200));
    expect(onEnd).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("keeps the elapsed fraction inside the bar", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ProgressBar duration={1_000} elapsed={-0.5} />); });
    expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 0 }]);
    act(() => r.unmount());
    act(() => { r = TestRenderer.create(<ProgressBar duration={1_000} elapsed={3} />); });
    expect(StyleSheet.flatten(fill(r).props.style).transform).toEqual([{ scaleX: 1 }]);
    act(() => r.unmount());
  });

  it("does not call onEnd when unmounted before it fills", () => {
    const onEnd = jest.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<ProgressBar duration={8_000} onEnd={onEnd} />); });
    act(() => jest.advanceTimersByTime(3_000));
    act(() => r.unmount());
    act(() => jest.advanceTimersByTime(10_000));
    expect(onEnd).not.toHaveBeenCalled();
  });
});
