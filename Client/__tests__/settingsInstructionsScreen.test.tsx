import React from "react";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import { Image, Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { TEST_IDS, settingsStepId } from "../app/utils/testIds";

// EXP-123: "Open Settings" must use the public Linking.openSettings() on iOS too (never a private App-Prefs URL),
// and the iOS steps must describe the app's own Settings page that it opens, not the Privacy path.
// EXP-190: Android step 1 shows App info, so it must say to tap "Permissions", not a generic text shared with iOS.
// EXP-196: the bottom inset pads the scroll content so the buttons clear the Android gesture bar.

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock("@/assets/images/PermInstructions1.jpg", () => "PermInstructions1", { virtual: true });
jest.mock("@/assets/images/PermInstructions2.jpg", () => "PermInstructions2", { virtual: true });
jest.mock("@/assets/images/PermInstructions3.jpg", () => "PermInstructions3", { virtual: true });
jest.mock("@/assets/images/IOSPermInstruction2.jpg", () => "IOSPermInstruction2", { virtual: true });
jest.mock("@/assets/images/IOSPermInstruction1.jpg", () => "IOSPermInstruction1", { virtual: true });
// Render every carousel item inline so all the steps can be inspected at once
jest.mock("@/app/components/CustomCarousel/CustomCarousel", () => {
  const React = require("react");
  const { View } = require("react-native");
  return React.forwardRef(({ data, renderItem }: any, _ref: any) => (
    <View>{data.map((item: any, index: number) => <View key={item.id}>{renderItem({ item, index })}</View>)}</View>
  ));
});
// A tall gesture-bar inset, so the test can tell whether the scroll content clears it
const MOCK_BOTTOM_INSET = 48;
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return {
    SafeAreaView: (props: any) => <View {...props} />,
    useSafeAreaInsets: () => ({ top: 24, bottom: MOCK_BOTTOM_INSET, left: 0, right: 0 }),
  };
});

const en = require("../app/i18n/en").default;
const es = require("../app/i18n/es").default;
let mockT = en;
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
// Platform.OS is read at render time, so the screen is imported once and rendered per platform
const SettingsInstructionsScreen = require("../app/screens/SettingsInstructionsScreen").default;

const render = async (os: "android" | "ios") => {
  const original = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<SettingsInstructionsScreen />);
  });
  return {
    tree,
    restore: () => Object.defineProperty(Platform, "OS", { configurable: true, get: () => original }),
  };
};

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(""));
const imageSources = (tree: ReactTestRenderer) => tree.root.findAllByType(Image).map((n) => n.props.source);
// The testID is forwarded down to host views: the first match is the component the screen rendered
const byTestID = (tree: ReactTestRenderer, id: string) => tree.root.findAll((n) => n.props.testID === id)[0];
const stepDescription = (tree: ReactTestRenderer, step: number) =>
  [].concat(byTestID(tree, settingsStepId(step)).props.children).join("").trim();
const pressOpenSettings = async (tree: ReactTestRenderer) => {
  await act(async () => {
    byTestID(tree, TEST_IDS.settingsInstructionsOpenSettings).props.onPress();
  });
};

describe("SettingsInstructionsScreen", () => {
  let openSettings: jest.SpyInstance;
  let openURL: jest.SpyInstance;
  let restorePlatform = () => {};

  beforeEach(() => {
    mockT = en;
    openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  });
  afterEach(() => {
    restorePlatform();
    openSettings.mockRestore();
    openURL.mockRestore();
  });

  // ── EXP-123 ──
  it.each(["ios", "android"] as const)("Open Settings uses Linking.openSettings(), never a private URL (%s)", async (os) => {
    const { tree, restore } = await render(os);
    restorePlatform = restore;
    await pressOpenSettings(tree);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalled();
  });

  it.each([
    ["en", en],
    ["es", es],
  ])("iOS steps start on the app's own Settings page, not the Privacy path (%s)", async (_lang, t) => {
    mockT = t;
    const { tree, restore } = await render("ios");
    restorePlatform = restore;
    const shown = texts(tree);

    expect(imageSources(tree)).toEqual(["IOSPermInstruction1", "IOSPermInstruction2"]);
    expect(stepDescription(tree, 1)).toBe(t.iosTapPhotosChooseAccess);
    expect(stepDescription(tree, 2)).toBe(t.iosConfirmFullAccess);
    expect(shown).not.toContain(t.step3);
    expect(shown.join(" ")).not.toMatch(/privacy|privacidad/i);
  });

  it("the Privacy-path copy and screenshots are gone", () => {
    for (const t of [en, es]) {
      expect(t).not.toHaveProperty("goPrivacySettings");
      expect(t).not.toHaveProperty("enablePermissions");
      expect(t).not.toHaveProperty("step4");
      expect(t).not.toHaveProperty("step5");
    }
    for (const unused of [3, 4, 5]) {
      expect(() => require(`../assets/images/IOSPermInstruction${unused}.jpg`)).toThrow();
    }
  });

  // ── EXP-190 ──
  it.each([
    ["en", en, /"Permissions"/],
    ["es", es, /"Permisos"/],
  ])("Android step 1 tells to tap Permissions on the App info page (%s)", async (_lang, t, permissions) => {
    mockT = t;
    const { tree, restore } = await render("android");
    restorePlatform = restore;

    expect(imageSources(tree)).toEqual(["PermInstructions1", "PermInstructions2", "PermInstructions3"]);
    expect(t.androidTapPermissions).toMatch(permissions);
    expect(stepDescription(tree, 1)).toBe(t.androidTapPermissions);
    expect(stepDescription(tree, 2)).toBe(t.tapPhotosVideos);
    expect(stepDescription(tree, 3)).toBe(t.allowAllTime);
  });

  // ── EXP-196 ──
  it.each(["android", "ios"] as const)("scroll content clears the bottom inset (%s)", async (os) => {
    const { tree, restore } = await render(os);
    restorePlatform = restore;
    const content = StyleSheet.flatten(tree.root.findByType(ScrollView).props.contentContainerStyle);
    expect(content.flexGrow).toBe(1);
    expect(content.paddingBottom).toBeGreaterThanOrEqual(MOCK_BOTTOM_INSET + 16);

    // The frame must not also pad the bottom edge (that would shrink the viewport instead of the content)
    const frame = tree.root.find((n) => n.type === View && n.props.testID === TEST_IDS.settingsInstructionsScreen);
    expect(frame.props.edges).toEqual(["top", "left", "right"]);
  });
});
