import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Animated, Keyboard, Platform, StyleSheet } from "react-native";
import { useKeyboardPadding } from "../app/hooks/useKeyboardPadding";
import InviteConfirmModal from "../app/components/modals/InviteConfirmModal";
import { TEST_IDS } from "../app/utils/testIds";
import { resetStack, stackRouter, StackScreens } from "../testUtils/stackRouter";

// EXP-347 review: the window does not shrink for the keyboard, so the lobby's chat footer and the invite dialog add
// the keyboard's height themselves. Without it, on Android the empty-name invite dialog (its field focused at once)
// had Join and Cancel under the keyboard.
// EXP-397: the padding follows the keyboard only while its screen is focused. Home, kept mounted under the lobby,
// animated its padding on iOS each time the lobby chat's keyboard came up.

jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
// Outside a stack a component stands for a focused screen; StackScreens focuses only the top one
jest.mock("expo-router", () => require("../testUtils/stackRouter").expoRouterMock);

const KEYBOARD_HEIGHT = 300;

/** Keyboard listeners the screen attached, by event, so a test can play the keyboard opening and closing. */
const keyboardListeners = new Map<string, (e?: unknown) => void>();
beforeEach(() => {
  keyboardListeners.clear();
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, listener: (e?: unknown) => void) => {
    keyboardListeners.set(event, listener);
    return { remove: () => keyboardListeners.delete(event) };
  }) as unknown as typeof Keyboard.addListener);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const showKeyboard = (event: string) =>
  act(() => { keyboardListeners.get(event)!({ endCoordinates: { height: KEYBOARD_HEIGHT } }); });
const hideKeyboard = (event: string) => act(() => { keyboardListeners.get(event)!(); });

let padding!: Animated.Value;
const Probe = () => { padding = useKeyboardPadding(); return null; };
/** Renders `element` with its effects run (the keyboard listeners attached). */
const render = (element: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(element); });
  return r;
};
const paddingValue = () => (padding as unknown as { __getValue: () => number }).__getValue();

describe("useKeyboardPadding", () => {
  it("on Android jumps to the keyboard's height once it is shown, and back to 0", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const r = render(<Probe />);

    showKeyboard("keyboardDidShow");
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);
    hideKeyboard("keyboardDidHide");
    expect(paddingValue()).toBe(0);
    act(() => r.unmount());
    expect(keyboardListeners.size).toBe(0);
  });

  it("on iOS slides with the keyboard", () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, "OS", "ios");
    const r = render(<Probe />);

    showKeyboard("keyboardWillShow");
    act(() => { jest.advanceTimersByTime(1000); });
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);
    hideKeyboard("keyboardWillHide");
    act(() => { jest.advanceTimersByTime(1000); });
    expect(paddingValue()).toBe(0);
    act(() => r.unmount());
  });
});

describe("useKeyboardPadding on a screen another one covers (EXP-397)", () => {
  const LOBBY = "/screens/WaitingRoom";
  /** The probe as home, at the bottom of the stack; a lobby without the hook goes over it */
  const renderHomeInStack = () => {
    resetStack();
    return render(<StackScreens screens={{ "/": Probe }} />);
  };
  const coverHome = () => act(() => stackRouter.push(LOBBY));
  const backToHome = () => act(() => stackRouter.back());
  const keyboardOnScreen = (height: number) => {
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(height > 0);
    jest.spyOn(Keyboard, "metrics").mockReturnValue(height > 0 ? { screenX: 0, screenY: 0, width: 400, height } : undefined);
  };

  it("doesn't listen to the keyboard while covered, and listens again once focused", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const r = renderHomeInStack();
    expect(keyboardListeners.has("keyboardWillShow")).toBe(true);

    coverHome();
    expect(keyboardListeners.size).toBe(0);

    backToHome();
    expect(keyboardListeners.has("keyboardWillShow")).toBe(true);
    act(() => r.unmount());
  });

  it("on iOS, back on top while the keyboard slides away (its will-hide missed), it drops to 0 once it is gone", () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, "OS", "ios");
    const r = renderHomeInStack();
    coverHome();
    keyboardOnScreen(KEYBOARD_HEIGHT); // React Native still sees it up: its did-hide comes at the end of the slide
    backToHome();
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);

    keyboardOnScreen(0);
    hideKeyboard("keyboardDidHide");
    act(() => { jest.advanceTimersByTime(1000); });
    expect(paddingValue()).toBe(0);
    act(() => r.unmount());
  });

  it.each([
    ["ios", "keyboardWillShow"],
    ["android", "keyboardDidShow"],
  ] as const)("on %s, covered with the keyboard up, it drops to 0 at once instead of staying raised under the other screen", (os, shown) => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, "OS", os);
    const r = renderHomeInStack();
    showKeyboard(shown);
    act(() => { jest.advanceTimersByTime(1000); });
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);

    coverHome(); // the keyboard's will-hide comes after home stopped listening
    act(() => { jest.advanceTimersByTime(1000); });
    expect(paddingValue()).toBe(0);
    act(() => r.unmount());
  });

  it("on iOS, the did-* events don't restart a slide its will-* event already started", () => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, "OS", "ios");
    const timing = jest.spyOn(Animated, "timing");
    const r = renderHomeInStack();
    showKeyboard("keyboardWillShow");
    showKeyboard("keyboardDidShow");
    hideKeyboard("keyboardWillHide");
    hideKeyboard("keyboardDidHide");
    expect(timing.mock.calls.map(([, config]) => config.toValue)).toEqual([KEYBOARD_HEIGHT, 0]);
    act(() => r.unmount());
  });

  it("back on top after the keyboard closed under the covering screen, it drops to 0", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const r = renderHomeInStack();
    showKeyboard("keyboardDidShow");
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);

    coverHome();
    keyboardOnScreen(0); // closed while home was covered: home never heard it
    backToHome();
    expect(paddingValue()).toBe(0);
    act(() => r.unmount());
  });

  it("back on top with the keyboard up, it starts at the keyboard's height", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const r = renderHomeInStack();
    coverHome();
    keyboardOnScreen(KEYBOARD_HEIGHT);
    backToHome();
    expect(paddingValue()).toBe(KEYBOARD_HEIGHT);
    act(() => r.unmount());
  });
});

describe("Invite dialog above the keyboard", () => {
  it("lifts its content by the keyboard's height (Android, empty name: the field is focused at once)", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const r = render(<InviteConfirmModal roomCode="XYZ789" initialName="" onJoin={async () => {}} onCancel={() => {}} />);
    // The dialog's content: the first host view inside the full-screen backdrop
    const content = () => {
      const backdrop = r.root.find((n) => n.props.testID === TEST_IDS.inviteConfirmModal && typeof n.type === "string");
      return backdrop.find((n) => n !== backdrop && typeof n.type === "string");
    };
    const contentPadding = () => StyleSheet.flatten(content().props.style).paddingBottom;

    expect(contentPadding()).toBe(0);
    showKeyboard("keyboardDidShow");
    expect(contentPadding()).toBe(KEYBOARD_HEIGHT);
    act(() => r.unmount());
  });
});
