import React from "react";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import { Image, Platform, ScrollView, StyleSheet, Text } from "react-native";

// EXP-088: the app only requests photo access (audio/video are blocked in app.json), so the onboarding
// must not teach users to accept a "music and audio" dialog that never appears.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock("@/app/providers/PhotoContext", () => ({ usePhotoContext: () => ({ handleContinue: jest.fn() }) }));
jest.mock("lottie-react-native", () => () => null);
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("@/assets/images/galleryPermissionIMG.jpg", () => "galleryPermissionIMG", { virtual: true });
jest.mock("@/assets/images/PermissionRequestIOS.jpg", () => "PermissionRequestIOS", { virtual: true });
// EXP-192: a tall gesture-bar inset, so the test can tell whether the scroll content clears it
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
const InitialScreen = require("../app/screens/InitialScreen").default;

const render = async (os: "android" | "ios") => {
  const original = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<InitialScreen />);
  });
  Object.defineProperty(Platform, "OS", { configurable: true, get: () => original });
  return tree;
};

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(""));
const imageSources = (tree: ReactTestRenderer) => tree.root.findAllByType(Image).map((n) => n.props.source);

describe("InitialScreen permission steps", () => {
  beforeEach(() => {
    mockT = en;
  });

  it.each([
    ["en", en],
    ["es", es],
  ])("Android shows only the photos dialog, without an audio-permission step (%s)", async (_lang, t) => {
    mockT = t;
    const tree = await render("android");
    const shown = texts(tree);

    expect(imageSources(tree)).toEqual(["galleryPermissionIMG"]);
    expect(shown).toContain(t.howToEnableAndroid);
    expect(shown.filter((s) => s === t.tapAllowAll)).toHaveLength(1);
    // No numbered steps: there is a single dialog to accept
    expect(shown).not.toContain(t.step1);
    expect(shown).not.toContain(t.step2);
    expect(shown.join(" ")).not.toMatch(/music|audio|música/i);
  });

  it("iOS still shows its single photo-access dialog", async () => {
    const tree = await render("ios");
    expect(imageSources(tree)).toEqual(["PermissionRequestIOS"]);
    expect(texts(tree)).toContain(en.howToEnableIOS);
    expect(texts(tree)).toContain(en.tapAllowAll);
  });

  it("the audio-dialog asset and its copy are gone", () => {
    expect(() => require("../assets/images/audioPermissionIMG.jpg")).toThrow();
    expect(en).not.toHaveProperty("tapAllow");
    expect(es).not.toHaveProperty("tapAllow");
  });

  // EXP-192: on edge-to-edge Android the hint under "Continue" sat behind the gesture bar and the
  // ScrollView could not scroll past it. The bottom inset belongs to the scroll content, not the frame.
  it.each(["android", "ios"] as const)("scroll content clears the bottom inset and shows the hint (%s)", async (os) => {
    const tree = await render(os);
    const scroll = tree.root.findByType(ScrollView);
    const content = StyleSheet.flatten(scroll.props.contentContainerStyle);
    expect(content.flexGrow).toBe(1);
    expect(content.paddingBottom).toBeGreaterThanOrEqual(MOCK_BOTTOM_INSET + 16);

    // The frame must not also pad the bottom edge (that would shrink the viewport instead of the content)
    const frame = tree.root.find((n) => n.props.testID === "initial-screen" && n.props.edges);
    expect(frame.props.edges).not.toContain("bottom");

    expect(texts(tree)).toContain(en.tapToProceed);
  });
});
