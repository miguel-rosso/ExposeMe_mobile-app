import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Animated, Keyboard, Platform, StyleSheet } from "react-native";
import { useKeyboardPadding } from "../app/hooks/useKeyboardPadding";
import InviteConfirmModal from "../app/components/modals/InviteConfirmModal";
import { TEST_IDS } from "../app/utils/testIds";

// EXP-347 review: the window does not shrink for the keyboard, so the lobby's chat footer and the invite dialog add
// the keyboard's height themselves. Without it, on Android the empty-name invite dialog (its field focused at once)
// had Join and Cancel under the keyboard.

jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));

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
