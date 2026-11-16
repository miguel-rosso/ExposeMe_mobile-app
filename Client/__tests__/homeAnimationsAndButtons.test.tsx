import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { StyleSheet, Text } from "react-native";
import { TEST_IDS } from "../src/utils/testIds";

// EXP-331 (characterization): the home screen's custom animations, its three brand buttons and the logo's shadow,
// pinned so that moving them out of app/index.tsx keeps exactly the same look and motion.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "acceptedTermsVersion" ? require("../src/utils/termsAcceptance").TERMS_VERSION : null));
  return mock;
});
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
// Animatable views record the keyframes and duration of every imperative animation, whether it is run by name
// (resolved through the registry the screen fills) or as a keyframes object
jest.mock("react-native-animatable", () => {
  const { forwardRef, useImperativeHandle, useRef } = require("react");
  const { View } = require("react-native");
  const registry: Record<string, unknown> = {};
  const calls = new Map<number, { keyframes: unknown; duration: number }[]>();
  let nextId = 0;
  const AnimatableView = forwardRef(
    ({ children, style, animation }: { children?: unknown; style?: unknown; animation?: unknown }, ref: unknown) => {
      const id = useRef(nextId++).current;
      const record = (keyframes: unknown, duration: number) => calls.set(id, [...(calls.get(id) ?? []), { keyframes, duration }]);
      useImperativeHandle(ref, () =>
        new Proxy({}, {
          get: (_target, name) =>
            name === "animate"
              ? (keyframes: unknown, duration: number) => record(keyframes, duration)
              : (duration: number) => record(registry[String(name)] ?? String(name), duration),
        })
      );
      return <View animId={id} animation={animation} style={style}>{children}</View>;
    }
  );
  return {
    View: AnimatableView,
    initializeRegistryWithDefinitions: (definitions: Record<string, unknown>) => Object.assign(registry, definitions),
    __registry: registry,
    __calls: calls,
  };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ check: async () => ({ status: "ok" }) }),
}));
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);
jest.mock("../src/providers/GameContext", () => {
  const { useState } = require("react");
  return {
    useGameContext: () => {
      const [username, setUsername] = useState("ana");
      const [joinCodeDraft, setJoinCodeDraft] = useState("");
      return {
        username, setUsername, setGameCode: () => {}, joinCodeDraft, setJoinCodeDraft, requestNewRoom: () => {},
        saveUsername: setUsername, socket: null, endSocket: () => {},
      };
    },
  };
});

import Index from "../app/index";
import en from "../src/i18n/en";

const { __registry: registry, __calls: animationCalls } = jest.requireMock("react-native-animatable") as {
  __registry: Record<string, unknown>;
  __calls: Map<number, { keyframes: unknown; duration: number }[]>;
};

// ── Expected keyframes (as they were defined in app/index.tsx) ──

const SLIDE_IN_DOWN_BOUNCE = {
  0: { opacity: 0, translateY: -15 },
  0.6: { opacity: 1, translateY: 10 },
  0.75: { opacity: 1, translateY: -5 },
  0.9: { opacity: 1, translateY: 2 },
  1: { opacity: 1, translateY: 0 },
};
const SLIDE_IN_UP_BOUNCE = {
  0: { opacity: 0, translateY: 15 },
  0.6: { opacity: 1, translateY: -10 },
  0.75: { opacity: 1, translateY: 5 },
  0.9: { opacity: 1, translateY: -2 },
  1: { opacity: 1, translateY: 0 },
};
const SLIDE_OUT_UP_BOUNCE = {
  0: { opacity: 0, translateY: 0 },
  0.25: { opacity: 1, translateY: -10 },
  0.5: { opacity: 1, translateY: -5 },
  0.75: { opacity: 1, translateY: 5 },
  1: { opacity: 1, translateY: 0 },
};
const SLIDE_OUT_DOWN_BOUNCE = {
  0: { opacity: 0, translateY: 0 },
  0.25: { opacity: 1, translateY: 10 },
  0.5: { opacity: 1, translateY: 5 },
  0.75: { opacity: 1, translateY: -5 },
  1: { opacity: 1, translateY: 0 },
};
const SLIDE_OUT_DOWN_FAR = { 0: { opacity: 1, translateY: 0 }, 1: { opacity: 0, translateY: 100 } };
const SLIDE_OUT_UP_FAR = { 0: { opacity: 1, translateY: 0 }, 1: { opacity: 0, translateY: -200 } };
const SLIDE_IN_DOWN_FAR = { 0: { opacity: 0, translateY: -200 }, 1: { opacity: 1, translateY: 0 } };

const BRAND_BUTTON_COLORS = ["#9d0420", "#e9042e", "#9d0420"];
const HOME_ANIMATION_MS = 600;
const SHAKE_MS = 500;

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());
beforeEach(() => animationCalls.clear());

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id);
const pressable = (root: ReactTestInstance, id: string) =>
  byTestId(root, id).find((n) => typeof n.props.onPress === "function")!;
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await pressable(root, id).props.onPress(); });
  await flush();
};
/** The Animatable view that wraps the element with `testID` */
const animatableAround = (root: ReactTestInstance, testID: string) =>
  root.findAll((n) => n.props.animId !== undefined && byTestId(n, testID).length > 0)[0];
const animationsOf = (root: ReactTestInstance, testID: string) =>
  animationCalls.get(animatableAround(root, testID).props.animId) ?? [];
const typeName = async (root: ReactTestInstance, text: string) => {
  const input = byTestId(root, TEST_IDS.usernameInput).find((n) => typeof n.props.onChange === "function")!;
  await act(async () => { await input.props.onChange({ nativeEvent: { text } }); });
  await flush();
};
const cancelJoin = async (root: ReactTestInstance) => {
  const backdrop = root.find(
    (n) => n.props.accessible === false && typeof n.props.onPress === "function" && byTestId(n, TEST_IDS.searchRoomButton).length > 0
  );
  await act(async () => { backdrop.props.onPress(); });
  await flush();
};

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  await flush();
  return r;
}

describe("Home custom animations (EXP-331)", () => {
  it("registers the animations used by name (animation prop and photo explorer exit) with their keyframes", () => {
    expect(registry.slideInDownBounce).toEqual(SLIDE_IN_DOWN_BOUNCE);
    expect(registry.slideInUpBounce).toEqual(SLIDE_IN_UP_BOUNCE);
    expect(registry.slideOutDownFar).toEqual(SLIDE_OUT_DOWN_FAR);
    expect(registry.slideOutUpFar).toEqual(SLIDE_OUT_UP_FAR);
    expect(registry.slideInDownFar).toEqual(SLIDE_IN_DOWN_FAR);
  });

  it("the join panel slides its code input down and its Search button up", async () => {
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    expect(animatableAround(r.root, TEST_IDS.gameCodeInput).props.animation).toBe("slideInDownBounce");
    expect(animatableAround(r.root, TEST_IDS.searchRoomButton).props.animation).toBe("slideInUpBounce");
    act(() => r.unmount());
  });

  it("cancelling the join panel brings the name back with an upward bounce and Join game with a downward one", async () => {
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    await cancelJoin(r.root);
    expect(animationsOf(r.root, TEST_IDS.usernameInput)).toEqual([
      { keyframes: SLIDE_OUT_UP_BOUNCE, duration: HOME_ANIMATION_MS },
    ]);
    expect(animationsOf(r.root, TEST_IDS.joinGameButton)).toEqual([
      { keyframes: SLIDE_OUT_DOWN_BOUNCE, duration: HOME_ANIMATION_MS },
    ]);
    act(() => r.unmount());
  });

  it("a blank name shakes the name field", async () => {
    const r = await mount();
    await typeName(r.root, "  ");
    await press(r.root, TEST_IDS.createGameButton);
    expect(animationsOf(r.root, TEST_IDS.usernameInput)).toEqual([{ keyframes: "shake", duration: SHAKE_MS }]);
    act(() => r.unmount());
  });

  it("an incomplete room code shakes the code field", async () => {
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    await press(r.root, TEST_IDS.searchRoomButton);
    expect(animationsOf(r.root, TEST_IDS.gameCodeInput)).toEqual([{ keyframes: "shake", duration: SHAKE_MS }]);
    act(() => r.unmount());
  });
});

describe("Home brand buttons and logo (EXP-331)", () => {
  const expectBrandButton = (root: ReactTestInstance, testID: string, label: string) => {
    const gradient = root.find((n) => Array.isArray(n.props.colors) && byTestId(n, testID).length > 0);
    expect([...gradient.props.colors]).toEqual(BRAND_BUTTON_COLORS);
    expect(gradient.props.start).toEqual({ x: 0, y: 0 });
    expect(gradient.props.end).toEqual({ x: 1, y: 0 });
    const button = pressable(gradient, testID);
    expect(button.findAll((n) => n.type === Text && n.props.children === label).length).toBeGreaterThan(0);
  };

  it("Create game, Join game and Search room are brand-gradient buttons with their labels", async () => {
    const r = await mount();
    expectBrandButton(r.root, TEST_IDS.createGameButton, en.createGame);
    expectBrandButton(r.root, TEST_IDS.joinGameButton, en.joinGame);
    await press(r.root, TEST_IDS.joinGameButton);
    expectBrandButton(r.root, TEST_IDS.searchRoomButton, en.searchRoom);
    act(() => r.unmount());
  });

  it("the logo uses the display font with its 10/5 px drop shadow", async () => {
    const r = await mount();
    const logo = r.root.find((n) => n.type === Text && n.props.children === en.appName);
    expect(StyleSheet.flatten(logo.props.style)).toEqual(
      expect.objectContaining({
        fontFamily: "IconFont",
        textShadowColor: "rgba(0, 0, 0, 0.5)",
        textShadowOffset: { width: 10, height: 5 },
        textShadowRadius: 3,
      })
    );
    act(() => r.unmount());
  });
});
