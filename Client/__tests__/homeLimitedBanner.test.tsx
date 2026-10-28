import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { AppState, Image, StyleSheet, Text } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import { BRAND_RED } from "../app/theme/brand";
import en from "../app/i18n/en";
import es from "../app/i18n/es";
import {
  HOME_TOP_ROW_TOP,
  LOGO_BOX_HEIGHT,
  LOGO_EMOJI_BANNER_CLEARANCE,
  LOGO_EMOJI_BOX_PERCENT,
  LOGO_EMOJI_FACE_TOP_INSET,
  LOGO_EMOJI_SIZE,
  LOGO_EMOJI_TOP,
} from "../app/utils/homeLayout";

// EXP-270: home banner for players who only share some photos (iOS limited, Android 14+ selected photos), with a
// button that opens the system picker to share more. Hidden with full access or no access at all.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});

// Home is the focused screen: focus effects run on mount and clean up on unmount
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
let mockLang: "en" | "es" = "en";
jest.mock("../app/i18n", () => ({
  useI18n: () => ({ t: mockLang === "es" ? require("../app/i18n/es").default : require("../app/i18n/en").default }),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", setUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), socket: null, endSocket: jest.fn(),
  }),
}));

// Real PhotoProvider over a mocked expo-media-library
type Perm = { status: string; canAskAgain: boolean; accessPrivileges?: string };
const LIMITED: Perm = { status: "granted", canAskAgain: true, accessPrivileges: "limited" };
const FULL: Perm = { status: "granted", canAskAgain: true, accessPrivileges: "all" };
const DENIED: Perm = { status: "denied", canAskAgain: false, accessPrivileges: "none" };
let mockPerm: Perm = LIMITED;
const mockRequest = jest.fn(async () => mockPerm);
const mockPicker = jest.fn(async () => {});
const mockPhotoQuery = jest.fn(async () => [{ id: "p1", mediaType: "image" }]);
jest.mock("expo-media-library", () => {
  class Query {
    eq() { return this; }
    limit() { return this; }
    exeForMetadata() { return mockPhotoQuery(); }
  }
  return {
    getPermissionsAsync: async () => mockPerm,
    requestPermissionsAsync: () => mockRequest(),
    presentPermissionsPicker: () => mockPicker(),
    addListener: () => ({ remove: () => {} }),
    Query,
    Asset: class {},
    AssetField: { MEDIA_TYPE: "mediaType" },
    MediaType: { IMAGE: "image" },
  };
});

import Index from "../app/index";
import { PhotoProvider } from "../app/providers/PhotoContext";

let appStateHandlers: ((s: string) => void)[] = [];
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return { remove: () => { appStateHandlers = appStateHandlers.filter((x) => x !== h); } };
  }) as typeof AppState.addEventListener);
  mockPerm = LIMITED;
  mockLang = "en";
  mockRequest.mockClear();
  mockPhotoQuery.mockClear();
  mockPicker.mockReset();
  mockPicker.mockImplementation(async () => {});
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const bannerTexts = (root: ReactTestInstance) =>
  root.findByProps({ testID: TEST_IDS.homeLimitedBanner }).findAllByType(Text).map((n) => n.props.children);
const comeBackToForeground = async () => {
  act(() => appStateHandlers.forEach((h) => h("active")));
  await flush();
};

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<PhotoProvider><Index /></PhotoProvider>); });
  await flush();
  return r;
}

describe("Home limited-access banner (EXP-270)", () => {
  it("limited / partial access: shows the banner with an Add more button, in English", async () => {
    const r = await mount();
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(true);
    expect(has(r.root, TEST_IDS.homeLimitedAddMore)).toBe(true);
    expect(bannerTexts(r.root)).toEqual([en.limitedAccessBanner, en.addMorePhotos]);
    act(() => r.unmount());
  });

  it("reads the permission only: no photo query (so no photo-query timeout) behind the banner", async () => {
    const r = await mount();
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(true);
    expect(mockPhotoQuery).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("stays on one line, with Add more as a brand-red pill with white text", async () => {
    const r = await mount();
    const banner = r.root.findByProps({ testID: TEST_IDS.homeLimitedBanner });
    expect(banner.findAllByType(Text).every((n) => n.props.numberOfLines === 1)).toBe(true);
    const addMore = r.root.find((n) => n.props.testID === TEST_IDS.homeLimitedAddMore && typeof n.props.onPress === "function");
    const pillStyle = Object.assign({}, ...[addMore.props.style].flat());
    expect(pillStyle.backgroundColor).toBe(BRAND_RED);
    const labelStyle = Object.assign({}, ...[addMore.findByType(Text).props.style].flat());
    expect(labelStyle).toMatchObject({ color: "#fff", fontWeight: "bold" });
    act(() => r.unmount());
  });

  it("speaks Spanish", async () => {
    mockLang = "es";
    const r = await mount();
    expect(bannerTexts(r.root)).toEqual([es.limitedAccessBanner, es.addMorePhotos]);
    expect(es.limitedAccessBanner).not.toBe(en.limitedAccessBanner);
    expect(es.addMorePhotos).not.toBe(en.addMorePhotos);
    act(() => r.unmount());
  });

  it.each([["full access", FULL], ["no access", DENIED]])("%s: no banner, and never prompts", async (_, perm) => {
    mockPerm = perm;
    const r = await mount();
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("Add more opens the system picker; the banner goes as soon as it grants full access", async () => {
    // Android 14+: the picker resolves once closed, and the user may allow all photos there
    mockPicker.mockImplementation(async () => { mockPerm = FULL; });
    const r = await mount();
    await act(async () => { await r.root.findByProps({ testID: TEST_IDS.homeLimitedAddMore }).props.onPress(); });
    await flush();
    expect(mockPicker).toHaveBeenCalledTimes(1);
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(false);
    act(() => r.unmount());
  });

  it("Add more that keeps the access limited (iOS picker) keeps the banner", async () => {
    const r = await mount();
    await act(async () => { await r.root.findByProps({ testID: TEST_IDS.homeLimitedAddMore }).props.onPress(); });
    await flush();
    expect(mockPicker).toHaveBeenCalledTimes(1);
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(true);
    act(() => r.unmount());
  });

  it("full access granted in Settings: gone on return to the foreground; limited again: back", async () => {
    const r = await mount();
    mockPerm = FULL;
    await comeBackToForeground();
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(false);
    mockPerm = LIMITED;
    await comeBackToForeground();
    expect(has(r.root, TEST_IDS.homeLimitedBanner)).toBe(true);
    act(() => r.unmount());
    expect(appStateHandlers).toHaveLength(0);
  });

});

// EXP-281: the banner pill touched the logo emoji. With the banner, the emoji shrinks towards its bottom edge to clear
// the measured banner; the logo box and the title keep exactly the layout they have without it, so the form below is
// never pushed down (jest has no layout engine: positions are fed through onLayout).
describe("Home logo vs the limited-access banner (EXP-281)", () => {
  const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 300, height } } });
  const logo = (root: ReactTestInstance) =>
    root.find((n) => n.props.animation === "slideInDown" && typeof n.props.onLayout === "function" && typeof n.type !== "string");
  const bannerWrapper = (root: ReactTestInstance) =>
    root.find((n) => typeof n.props.onLayout === "function" && n.parent?.props.pointerEvents === "box-none");
  const emoji = (root: ReactTestInstance) =>
    root.find((n) => n.type === Image && StyleSheet.flatten(n.props.style)?.top === LOGO_EMOJI_TOP);
  const title = (root: ReactTestInstance) => root.find((n) => n.type === Text && n.props.children === en.appName);
  const emojiTransform = (root: ReactTestInstance) => StyleSheet.flatten(emoji(root).props.style);

  /** Mounts home and lays out the logo at top-[10%] of `height`, and the banner wrapper (0 high when hidden) */
  async function mountLaidOut(height: number, banner: { y: number; height: number }) {
    const r = await mount();
    act(() => logo(r.root).props.onLayout(layout(height * 0.1, LOGO_BOX_HEIGHT)));
    act(() => bannerWrapper(r.root).props.onLayout(layout(banner.y, banner.height)));
    return r;
  }
  const faceTop = (logoTop: number, scale: number) =>
    logoTop + LOGO_EMOJI_TOP + LOGO_EMOJI_SIZE - scale * LOGO_EMOJI_SIZE * (1 - LOGO_EMOJI_FACE_TOP_INSET);

  it.each([["360x592", 592], ["360x640", 640]])("%s: the emoji clears the banner, the title does not move", async (_, height) => {
    mockPerm = FULL;
    const full = await mountLaidOut(height, { y: 0, height: 0 });
    const fullLogoStyle = StyleSheet.flatten(logo(full.root).props.style);
    const fullTitleStyle = StyleSheet.flatten(title(full.root).props.style);
    expect(emojiTransform(full.root).transform).toBeUndefined(); // full access: the usual layout
    act(() => full.unmount());

    mockPerm = LIMITED;
    const pill = { y: 5, height: 30 }; // centred in the 40 pt row
    const r = await mountLaidOut(height, pill);
    expect(StyleSheet.flatten(logo(r.root).props.style)).toEqual(fullLogoStyle);
    expect(StyleSheet.flatten(title(r.root).props.style)).toEqual(fullTitleStyle);
    const style = emojiTransform(r.root);
    expect(style.transformOrigin).toBe("bottom"); // its bottom edge stays put: it only gets smaller upwards
    const [{ scale }] = style.transform;
    expect(scale).toBeLessThan(1);
    const bannerBottom = HOME_TOP_ROW_TOP + pill.y + pill.height;
    expect(faceTop(height * 0.1, scale)).toBeGreaterThanOrEqual(bannerBottom + LOGO_EMOJI_BANNER_CLEARANCE - 0.001);
    act(() => r.unmount());
  });

  it("a banner grown by a large system font is measured, and the emoji shrinks further", async () => {
    const height = 844;
    const normal = await mountLaidOut(height, { y: 5, height: 30 });
    const normalScale = emojiTransform(normal.root).transform[0].scale;
    act(() => normal.unmount());

    const large = { y: 0, height: 60 }; // 2x font: the pill outgrows the 40 pt row
    const r = await mountLaidOut(height, large);
    const [{ scale }] = emojiTransform(r.root).transform;
    expect(scale).toBeLessThan(normalScale);
    const bannerBottom = HOME_TOP_ROW_TOP + large.y + large.height;
    expect(faceTop(height * 0.1, scale)).toBeGreaterThanOrEqual(bannerBottom + LOGO_EMOJI_BANNER_CLEARANCE - 0.001);
    act(() => r.unmount());
  });

  it("the logo box and the emoji are laid out from the same constants logoEmojiScale uses", async () => {
    mockPerm = FULL;
    const r = await mount();
    const emojiStyle = StyleSheet.flatten(emoji(r.root).props.style);
    expect(emojiStyle).toMatchObject({ top: LOGO_EMOJI_TOP, width: LOGO_EMOJI_BOX_PERCENT, height: LOGO_EMOJI_BOX_PERCENT });
    expect(StyleSheet.flatten(emoji(r.root).parent!.props.style).height).toBe(LOGO_BOX_HEIGHT);
    expect(LOGO_EMOJI_SIZE).toBe((LOGO_BOX_HEIGHT * parseFloat(LOGO_EMOJI_BOX_PERCENT)) / 100);
    act(() => r.unmount());
  });

  it("access becomes full: the banner wrapper collapses and the emoji goes back to its usual size", async () => {
    const r = await mountLaidOut(640, { y: 5, height: 30 });
    expect(emojiTransform(r.root).transform).toBeDefined();
    act(() => bannerWrapper(r.root).props.onLayout(layout(0, 0)));
    expect(emojiTransform(r.root).transform).toBeUndefined();
    act(() => r.unmount());
  });
});
