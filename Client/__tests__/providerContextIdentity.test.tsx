import React from "react";
import * as ReactNative from "react-native";
import TestRenderer, { act } from "react-test-renderer";

// EXP-309: each provider module (GameContext, PhotoContext, BackgroundContext) is re-evaluated by Fast Refresh when it
// is edited. Its context object lives in a separate module, so a re-evaluated copy of the provider module still uses
// the same context and the mounted provider keeps serving the new hook. Each test loads two isolated copies of a
// provider module that share only the context module (and React): the provider of one copy must serve the other's hook.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("socket.io-client", () => ({ io: jest.fn() }));
jest.mock("expo-media-library", () => ({}));
// The background hook follows its screen's focus; the probes stand for a focused screen
jest.mock("expo-router", () => ({ useIsFocused: () => true }));

const GAME_PROVIDER = "../src/providers/GameContext";
const GAME_CONTEXT = "../src/providers/GameContextInstance";
const PHOTO_PROVIDER = "../src/providers/PhotoContext";
const PHOTO_CONTEXT = "../src/providers/PhotoContextInstance";
const BACKGROUND_PROVIDER = "../src/providers/BackgroundContext";
const BACKGROUND_CONTEXT = "../src/providers/BackgroundContextInstance";

/** A fresh evaluation of `providerPath` (as after a Fast Refresh) that shares React and the context module. */
const loadProviderCopy = <T,>(providerPath: string, contextPath: string): T => {
  const sharedContextModule = require(contextPath);
  let copy!: T;
  jest.isolateModules(() => {
    jest.doMock("react", () => React);
    jest.doMock("react-native", () => ReactNative);
    jest.doMock(contextPath, () => sharedContextModule);
    copy = require(providerPath);
  });
  return copy;
};

/** Renders `hook` under `Provider` (or alone) and returns what it gave back. */
const readHook = <T,>(hook: () => T, Provider?: React.FC<{ children: React.ReactNode }>): T => {
  let value!: T;
  const Probe = () => {
    value = hook();
    return null;
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(Provider ? <Provider><Probe /></Provider> : <Probe />);
  });
  act(() => renderer.unmount());
  return value;
};

/** Rendering `hook` without its provider throws `message` (React also logs the error, silenced here). */
const expectThrowsWithoutProvider = (hook: () => unknown, message: string) => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  const Probe = () => {
    hook();
    return null;
  };
  expect(() => act(() => { TestRenderer.create(<Probe />); })).toThrow(message);
  consoleError.mockRestore();
};

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

describe("provider contexts survive a re-evaluation of their provider module (EXP-309)", () => {
  it("GameContext: the provider from one copy serves the hook from another", () => {
    type GameModule = typeof import("../src/providers/GameContext");
    const mounted = loadProviderCopy<GameModule>(GAME_PROVIDER, GAME_CONTEXT);
    const refreshed = loadProviderCopy<GameModule>(GAME_PROVIDER, GAME_CONTEXT);
    expect(refreshed.useGameContext).not.toBe(mounted.useGameContext);

    const ctx = readHook(refreshed.useGameContext, mounted.GameProvider);
    expect(typeof ctx.startSocket).toBe("function");
    expectThrowsWithoutProvider(refreshed.useGameContext, "useGameContext must be used within a GameProvider");
  });

  it("PhotoContext: the provider from one copy serves the hook from another", () => {
    type PhotoModule = typeof import("../src/providers/PhotoContext");
    const mounted = loadProviderCopy<PhotoModule>(PHOTO_PROVIDER, PHOTO_CONTEXT);
    const refreshed = loadProviderCopy<PhotoModule>(PHOTO_PROVIDER, PHOTO_CONTEXT);
    expect(refreshed.usePhotoContext).not.toBe(mounted.usePhotoContext);

    const ctx = readHook(refreshed.usePhotoContext, mounted.PhotoProvider);
    expect(typeof ctx.pickGamePhoto).toBe("function");
    expectThrowsWithoutProvider(refreshed.usePhotoContext, "usePhotoContext must be used within a PhotoProvider");
  });

  it("BackgroundContext: the provider from one copy serves the hook from another", () => {
    type BackgroundModule = typeof import("../src/providers/BackgroundContext");
    const mounted = loadProviderCopy<BackgroundModule>(BACKGROUND_PROVIDER, BACKGROUND_CONTEXT);
    const refreshed = loadProviderCopy<BackgroundModule>(BACKGROUND_PROVIDER, BACKGROUND_CONTEXT);
    expect(refreshed.useBackgroundContext).not.toBe(mounted.useBackgroundContext);
    expect(refreshed.BackgroundContext).toBe(mounted.BackgroundContext);

    // Without a provider the hook keeps returning the context default (it never threw)
    const fallback = readHook(refreshed.useBackgroundContext);
    const { backgrounds } = require(BACKGROUND_CONTEXT);
    expect(fallback.backgroundImage).toBe(backgrounds[0]);

    // The provider starts on the last background (Math.random pinned), not the context default: it served the hook
    const random = jest.spyOn(Math, "random").mockReturnValue(0.99);
    const ctx = readHook(refreshed.useBackgroundContext, mounted.BackgroundProvider);
    random.mockRestore();
    expect(ctx.backgroundImage).toBe(backgrounds[backgrounds.length - 1]);
  });
});
