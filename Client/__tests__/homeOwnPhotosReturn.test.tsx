import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { TEST_IDS } from "../app/utils/testIds";

// EXP-243: opening the photo explorer animates every home element out and then pushes it. Home stays mounted
// underneath, so when it is focused again (back) its elements must animate back in; otherwise the menu is left
// with only the background and the language flag. Double taps while leaving push only once.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});

// Focus events: useFocusEffect runs its effect while focused (on mount and on each simulated refocus) and its
// cleanup on each simulated blur
const mockFocusListeners = new Set<(focused: boolean) => void>();
const mockPush = jest.fn();
jest.mock("expo-router", () => {
  const { useEffect, useState } = require("react");
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (effect: () => void | (() => void)) => {
      const [focus, setFocus] = useState({ focused: true, count: 0 });
      useEffect(() => {
        const onFocusChange = (focused: boolean) => setFocus((f: { count: number }) => ({ focused, count: f.count + 1 }));
        mockFocusListeners.add(onFocusChange);
        return () => { mockFocusListeners.delete(onFocusChange); };
      }, []);
      useEffect(() => (focus.focused ? effect() : undefined), [effect, focus]);
    },
  };
});

// Animatable views record whether their last imperative animation left them hidden ("...Out...") or shown
const mockAnimated = new Map<number, "shown" | "hidden">();
jest.mock("react-native-animatable", () => {
  const { forwardRef, useImperativeHandle, useRef } = require("react");
  const { View } = require("react-native");
  let nextId = 0;
  const AnimatableView = forwardRef(({ children, style }: { children?: unknown; style?: unknown }, ref: unknown) => {
    const id = useRef(nextId++).current;
    useImperativeHandle(ref, () =>
      new Proxy({}, {
        get: (_target, name) => () => mockAnimated.set(id, /Out/.test(String(name)) ? "hidden" : "shown"),
      })
    );
    return <View style={style}>{children}</View>;
  });
  return { View: AnimatableView, initializeRegistryWithDefinitions: jest.fn() };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("@/app/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn(), dismiss: jest.fn() }),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", setUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), socket: null, endSocket: jest.fn(),
  }),
}));

import Index from "../app/index";
import { SCREEN_EXIT_ANIMATION_MS } from "../app/hooks/useExitAnimationNavigation";

const HOME_ANIMATED_ELEMENTS = 6; // logo, username, create, join, explorer button and its label

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  mockAnimated.clear();
  mockFocusListeners.clear();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const pressOwnPhotos = (root: ReactTestInstance) =>
  act(() => { root.find((n) => n.props.testID === TEST_IDS.ownPhotosButton && typeof n.props.onPress === "function").props.onPress(); });
const hiddenCount = () => [...mockAnimated.values()].filter((v) => v === "hidden").length;
const setFocused = (focused: boolean) => act(() => { mockFocusListeners.forEach((onChange) => onChange(focused)); });
const refocus = () => { setFocused(false); setFocused(true); };

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  await flush();
  return r;
}

describe("Home after returning from the photo explorer (EXP-243)", () => {
  it("animates its elements out, opens the explorer, and shows them again when focused again", async () => {
    const r = await mount();
    pressOwnPhotos(r.root);
    expect(hiddenCount()).toBe(HOME_ANIMATED_ELEMENTS);
    expect(mockPush).not.toHaveBeenCalled();
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).toHaveBeenCalledWith("/screens/OwnPhotos");

    refocus(); // back from the explorer
    expect(hiddenCount()).toBe(0);
    expect(mockAnimated.size).toBe(HOME_ANIMATED_ELEMENTS);

    // It can be opened again afterwards
    pressOwnPhotos(r.root);
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
  });

  it("a double tap while leaving opens the explorer only once", async () => {
    const r = await mount();
    pressOwnPhotos(r.root);
    pressOwnPhotos(r.root);
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    pressOwnPhotos(r.root); // still leaving: home has not been focused again
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("refocusing without having left does not replay any animation", async () => {
    const r = await mount();
    refocus();
    expect(mockAnimated.size).toBe(0);
    act(() => r.unmount());
  });

  it("opening another screen during the exit cancels the pending push; the elements come back on refocus", async () => {
    const r = await mount();
    pressOwnPhotos(r.root);
    setFocused(false); // e.g. Create game pushed the waiting room within the exit animation
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).not.toHaveBeenCalledWith("/screens/OwnPhotos");
    expect(hiddenCount()).toBe(HOME_ANIMATED_ELEMENTS);

    setFocused(true); // back from the waiting room
    expect(hiddenCount()).toBe(0);
    pressOwnPhotos(r.root);
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("unmounting while leaving cancels the pending push", async () => {
    const r = await mount();
    pressOwnPhotos(r.root);
    act(() => r.unmount());
    act(() => { jest.advanceTimersByTime(SCREEN_EXIT_ANIMATION_MS); });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
