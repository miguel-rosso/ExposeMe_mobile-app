import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Keyboard, Platform, StyleSheet, TouchableWithoutFeedback } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { recordTermsAccepted } from "../src/utils/termsAcceptance";
import { TEST_IDS } from "../src/utils/testIds";

// EXP-378: the join panel works with the keyboard. The room code field opens focused, its return key ("go") searches
// the room, and a tap outside the field first only closes the keyboard; with the keyboard hidden it closes the panel.
// The panel rises above the keyboard (the window doesn't shrink for it) while the logo fades out, the clear buttons
// of the code and the name keep the keyboard up, and home closes the keyboard when another screen covers it. Real
// GameProvider, real home.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockPush = jest.fn();
// Whether home is the focused screen; a test covers it with another screen through setHomeFocused
let mockHomeFocused = true;
const mockFocusListeners = new Set<() => void>();
jest.mock("expo-router", () => {
  const { useEffect, useSyncExternalStore } = require("react");
  const subscribe = (listener: () => void) => {
    mockFocusListeners.add(listener);
    return () => mockFocusListeners.delete(listener);
  };
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn(), canGoBack: () => false }),
    useLocalSearchParams: () => ({}),
    // Like expo-router: the callback runs on focus, its cleanup when the screen loses focus
    useFocusEffect: (callback: () => void | (() => void)) => {
      const focused = useSyncExternalStore(subscribe, () => mockHomeFocused);
      useEffect(() => (focused ? callback() : undefined), [callback, focused]);
    },
  };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => "initial-screen");
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ check: async () => ({ status: "ok" }) }),
}));
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);

import Index from "../app/index";
import { GameProvider } from "../src/providers/GameContext";
import en from "../src/i18n/en";

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

const ROOM = "K7MQ4X";
const KEYBOARD_HEIGHT = 300;

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const codeInput = (root: ReactTestInstance) =>
  byTestId(root, TEST_IDS.gameCodeInput).find((n) => typeof n.props.onChangeText === "function");
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await byTestId(root, id).find((n) => typeof n.props.onPress === "function")!.props.onPress(); });
  await flush();
};
const typeCode = (root: ReactTestInstance, code: string) => act(() => codeInput(root)!.props.onChangeText(code));
/** The keyboard's return key on the room code field */
const submitCode = async (root: ReactTestInstance) => {
  await act(async () => { await codeInput(root)!.props.onSubmitEditing({ nativeEvent: { text: "" } }); });
  await flush();
};
const tapOutsideJoinPanel = async (root: ReactTestInstance) => {
  act(() => root.findByType(TouchableWithoutFeedback).props.onPress());
  await flush();
};
const setHomeFocused = (focused: boolean) =>
  act(() => {
    mockHomeFocused = focused;
    mockFocusListeners.forEach((listener) => listener());
  });

/** Keyboard listeners the screen attached, by event, so a test can play the keyboard opening and closing */
const keyboardListeners = new Map<string, (e?: unknown) => void>();
const showKeyboard = (event: string) =>
  act(() => { keyboardListeners.get(event)!({ endCoordinates: { height: KEYBOARD_HEIGHT } }); });
const hideKeyboard = (event: string) => act(() => { keyboardListeners.get(event)!(); });

let app: TestRenderer.ReactTestRenderer | null = null;
let keyboardVisible: jest.SpyInstance;
let dismissKeyboard: jest.SpyInstance;
let addKeyboardListener: jest.SpyInstance;

/** Home with its form */
const showHome = async () => {
  await act(async () => { app = TestRenderer.create(<GameProvider><Index /></GameProvider>); });
  await flush();
  return app!.root;
};
/** Home with the join panel open */
const openJoinPanel = async () => {
  const root = await showHome();
  await press(root, TEST_IDS.joinGameButton);
  return root;
};

beforeEach(async () => {
  await AsyncStorage.clear();
  await recordTermsAccepted();
  await AsyncStorage.setItem("username", "ana");
  mockPush.mockReset();
  mockHomeFocused = true;
  keyboardListeners.clear();
  addKeyboardListener = jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, listener: (e?: unknown) => void) => {
    keyboardListeners.set(event, listener);
    return { remove: () => keyboardListeners.delete(event) };
  }) as unknown as typeof Keyboard.addListener);
  keyboardVisible = jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
  dismissKeyboard = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  [keyboardVisible, dismissKeyboard, addKeyboardListener].forEach((spy) => spy.mockRestore());
});

describe("Home's join panel with the keyboard (EXP-378)", () => {
  it("opens with the room code field focused, its return key labelled Go and kept from blurring it", async () => {
    const root = await openJoinPanel();
    const input = codeInput(root)!;
    expect(input.props.autoFocus).toBe(true);
    expect(input.props.returnKeyType).toBe("go");
    expect(input.props.submitBehavior).toBe("submit");
  });

  it("rises above the keyboard: the panel is padded by the keyboard's height while it is up", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const root = await openJoinPanel();
    const panelPadding = () =>
      StyleSheet.flatten(
        root.find((n) => n.props.testID === TEST_IDS.joinPanel && typeof n.type === "string").props.style
      ).paddingBottom;

    expect(panelPadding()).toBe(0);
    showKeyboard("keyboardDidShow");
    expect(panelPadding()).toBe(KEYBOARD_HEIGHT);
    hideKeyboard("keyboardDidHide");
    expect(panelPadding()).toBe(0);
  });

  it("the top logo fades out as the keyboard comes up, and back in once it is gone", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const root = await openJoinPanel();
    const logoOpacity = () =>
      StyleSheet.flatten(root.find((n) => n.props.testID === TEST_IDS.homeLogo && typeof n.type === "string").props.style)
        .opacity;
    const showKeyboardOf = (height: number) =>
      act(() => { keyboardListeners.get("keyboardDidShow")!({ endCoordinates: { height } }); });

    expect(logoOpacity()).toBe(1);
    showKeyboardOf(75); // halfway to the height that hides it
    expect(logoOpacity()).toBeCloseTo(0.5);
    showKeyboardOf(KEYBOARD_HEIGHT);
    expect(logoOpacity()).toBe(0);
    hideKeyboard("keyboardDidHide");
    expect(logoOpacity()).toBe(1);
  });

  it("the return key with a full code closes the keyboard and searches the room", async () => {
    const root = await openJoinPanel();
    typeCode(root, ROOM);
    await submitCode(root);
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
  });

  it("the return key with an incomplete code searches nothing and leaves the keyboard up to fix it", async () => {
    const root = await openJoinPanel();
    typeCode(root, "K7M");
    await submitCode(root);
    expect(mockPush).not.toHaveBeenCalled();
    expect(dismissKeyboard).not.toHaveBeenCalled();
    expect(codeInput(root)).toBeDefined();
  });

  it("Search room closes the keyboard before opening the room", async () => {
    const root = await openJoinPanel();
    typeCode(root, ROOM);
    await press(root, TEST_IDS.searchRoomButton);
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
  });

  it("closes the keyboard when another screen covers home (e.g. an invite link opening the lobby over it)", async () => {
    await openJoinPanel();
    expect(dismissKeyboard).not.toHaveBeenCalled();
    setHomeFocused(false);
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
  });

  // EXP-397: covered by the lobby, home no longer follows the lobby chat's keyboard (on iOS it animated its padding)
  it("covered by another screen, home stops listening to the keyboard, and listens again once back on top", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    await openJoinPanel();
    expect(keyboardListeners.has("keyboardWillShow")).toBe(true);
    setHomeFocused(false);
    expect(keyboardListeners.size).toBe(0);
    setHomeFocused(true);
    expect(keyboardListeners.has("keyboardWillShow")).toBe(true);
  });

  it("a tap outside with the keyboard up only closes the keyboard: the panel and the typed code stay", async () => {
    const root = await openJoinPanel();
    typeCode(root, "K7M");
    keyboardVisible.mockReturnValue(true);
    await tapOutsideJoinPanel(root);
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(codeInput(root)!.props.value).toBe("K7M");
    expect(byTestId(root, TEST_IDS.joinGameButton)).toHaveLength(0);
  });

  it("a tap outside with the keyboard hidden closes the panel: the home form is back", async () => {
    const root = await openJoinPanel();
    await tapOutsideJoinPanel(root);
    expect(dismissKeyboard).not.toHaveBeenCalled();
    expect(codeInput(root)).toBeUndefined();
    expect(byTestId(root, TEST_IDS.joinGameButton).length).toBeGreaterThan(0);
  });

  it("the code's clear button empties the field and leaves the keyboard up to type the right code", async () => {
    const root = await openJoinPanel();
    typeCode(root, "K7M");
    const clearCode = root.find((n) => n.props.accessibilityLabel === en.clearGameCode && typeof n.props.onPress === "function");
    act(() => clearCode.props.onPress());
    await flush();
    expect(codeInput(root)!.props.value).toBe("");
    expect(dismissKeyboard).not.toHaveBeenCalled();
  });

  it("the name's clear button empties the field and leaves the keyboard up to type the new name", async () => {
    const root = await showHome();
    await press(root, TEST_IDS.usernameClearButton);
    const nameInput = byTestId(root, TEST_IDS.usernameInput).find((n) => typeof n.props.onChange === "function")!;
    expect(nameInput.props.value).toBe("");
    expect(dismissKeyboard).not.toHaveBeenCalled();
  });
});
