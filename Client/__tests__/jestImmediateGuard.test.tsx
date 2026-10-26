import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StatusBar } from "react-native";

// A fake-timer handle that reaches Node's real clearImmediate must not stop later real immediates from running
// (jest.setup.ts). Unguarded, Node's pending-immediate count drops below the real number of immediates, React's act()
// and Jest's end-of-file step wait forever, and random suites time out or the whole run stalls.

// Short on purpose: unguarded, these tests hang rather than fail
const HANG_TIMEOUT_MS = 2000;

const realImmediateRuns = () => new Promise<string>((resolve) => setImmediate(() => resolve("ran")));

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("clearImmediate guard", () => {
  it("ignores a stale fake-timer handle", async () => {
    jest.useFakeTimers();
    const fakeHandle = setImmediate(() => {});
    jest.useRealTimers();

    clearImmediate(fakeHandle);

    await expect(realImmediateRuns()).resolves.toBe("ran");
  }, HANG_TIMEOUT_MS);

  it("still cancels a real immediate", async () => {
    const callback = jest.fn();
    clearImmediate(setImmediate(callback));
    await realImmediateRuns();
    expect(callback).not.toHaveBeenCalled();
  }, HANG_TIMEOUT_MS);

  it("keeps immediates working when a StatusBar mounted under fake timers mounts again on real timers", async () => {
    jest.useFakeTimers();
    let first!: TestRenderer.ReactTestRenderer;
    act(() => { first = TestRenderer.create(<StatusBar barStyle="light-content" />); });
    act(() => first.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();

    let second!: TestRenderer.ReactTestRenderer;
    act(() => { second = TestRenderer.create(<StatusBar barStyle="light-content" />); });

    // The first one also flushes the StatusBar update; unguarded, that leaves the count short and the next one hangs
    await realImmediateRuns();
    await expect(realImmediateRuns()).resolves.toBe("ran");
    act(() => second.unmount());
  }, HANG_TIMEOUT_MS);
});
