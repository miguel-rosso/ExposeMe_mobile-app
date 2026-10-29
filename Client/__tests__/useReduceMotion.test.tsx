import React from "react";
import { AccessibilityInfo } from "react-native";
import TestRenderer, { act } from "react-test-renderer";
import { resetReduceMotionSettingForTests, useReduceMotion, useReduceMotionSetting } from "../app/hooks/useReduceMotion";

// EXP-315: the setting was asked again on every mount and read false until the answer came back, so a component that
// mounted already on screen (the scoreboard after a hold or on rejoin) bounced once with Reduce Motion on.

let answerQuery: (enabled: boolean) => void;
let failQuery: (error: Error) => void;
let systemChange: ((enabled: boolean) => void) | undefined;
let removeSystemListener: jest.Mock;

beforeEach(() => {
  resetReduceMotionSettingForTests();
  // react-native's jest setup already mocks AccessibilityInfo, so spyOn reuses those mocks and their call counts
  jest.clearAllMocks();
  systemChange = undefined;
  removeSystemListener = jest.fn();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(() => new Promise((resolve, reject) => {
    answerQuery = resolve;
    failQuery = reject;
  }));
  jest.spyOn(AccessibilityInfo, "addEventListener").mockImplementation(((_: string, fn: (enabled: boolean) => void) => {
    systemChange = fn;
    return { remove: removeSystemListener };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
});
afterEach(() => {
  resetReduceMotionSettingForTests();
  jest.restoreAllMocks();
});

const mountProbe = () => {
  const seen: (boolean | undefined)[] = [];
  const Probe = () => { seen.push(useReduceMotionSetting()); return null; };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Probe />); });
  return { seen, renderer };
};

describe("useReduceMotionSetting cache (EXP-315)", () => {
  it("a consumer that mounts after the system answered reads the setting on its very first render", async () => {
    const game = mountProbe(); // GameScreen: mounted for the whole game, it triggers the query
    expect(game.seen).toEqual([undefined]);
    await act(async () => answerQuery(true));
    expect(game.seen.at(-1)).toBe(true);

    const scoreboard = mountProbe(); // the scoreboard remounting already visible
    expect(scoreboard.seen[0]).toBe(true);
    expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
    act(() => { game.renderer.unmount(); scoreboard.renderer.unmount(); });
  });

  it("keeps the setting after every consumer unmounted, so the next screen still reads it at once", async () => {
    const first = mountProbe();
    await act(async () => answerQuery(true));
    act(() => first.renderer.unmount());

    const next = mountProbe();
    expect(next.seen[0]).toBe(true);
    act(() => next.renderer.unmount());
  });

  it("watches the system once and pushes its changes to every mounted consumer", async () => {
    const a = mountProbe();
    const b = mountProbe();
    await act(async () => answerQuery(false));
    expect(AccessibilityInfo.addEventListener).toHaveBeenCalledTimes(1);

    act(() => systemChange!(true));
    expect([a.seen.at(-1), b.seen.at(-1)]).toEqual([true, true]);

    act(() => b.renderer.unmount());
    const rendersOfB = b.seen.length;
    act(() => systemChange!(false));
    expect(a.seen.at(-1)).toBe(false);
    expect(b.seen).toHaveLength(rendersOfB);
    act(() => a.renderer.unmount());
  });

  it("a change made while nobody was mounted is what the next consumer reads", async () => {
    const first = mountProbe();
    await act(async () => answerQuery(false));
    act(() => first.renderer.unmount());
    act(() => systemChange!(true));

    const next = mountProbe();
    expect(next.seen[0]).toBe(true);
    act(() => next.renderer.unmount());
  });

  it("a change that arrives before the first answer wins over the older answer", async () => {
    const probe = mountProbe();
    act(() => systemChange!(true));
    await act(async () => answerQuery(false));
    expect(probe.seen.at(-1)).toBe(true);
    act(() => probe.renderer.unmount());
  });

  it("reads false when the system setting cannot be read, and useReduceMotion is false while waiting", async () => {
    const seen: [boolean | undefined, boolean][] = [];
    const Probe = () => { seen.push([useReduceMotionSetting(), useReduceMotion()]); return null; };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Probe />); });
    expect(seen.at(-1)).toEqual([undefined, false]);
    await act(async () => failQuery(new Error("unavailable")));
    expect(seen.at(-1)).toEqual([false, false]);
    act(() => renderer.unmount());
  });

  it("the test reset forgets the setting and stops watching the system", async () => {
    const probe = mountProbe();
    await act(async () => answerQuery(true));
    act(() => probe.renderer.unmount());

    resetReduceMotionSettingForTests();
    expect(removeSystemListener).toHaveBeenCalledTimes(1);
    const cold = mountProbe();
    expect(cold.seen[0]).toBeUndefined();
    act(() => cold.renderer.unmount());
  });
});
