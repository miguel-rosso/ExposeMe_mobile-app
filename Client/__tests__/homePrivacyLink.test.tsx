import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Dimensions, Linking, StyleSheet, Text } from "react-native";
import { TEST_IDS } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
import {
  PHOTO_EXPLORER_BUTTON_BOTTOM,
  PHOTO_EXPLORER_BUTTON_PADDING,
  PHOTO_EXPLORER_BUTTON_SIZE,
  PHOTO_EXPLORER_ICON_SIZE,
  PHOTO_EXPLORER_LABEL_BOTTOM,
  PRIVACY_LINK_BOTTOM,
  PRIVACY_LINK_HIT_SLOP,
  PRIVACY_LINK_LINE_HEIGHT,
  PRIVACY_LINK_MAX_FONT_SCALE,
  PRIVACY_LINK_MAX_LINES,
  PRIVACY_LINK_PADDING_Y,
  PRIVACY_LINK_RIGHT,
  privacyLinkMaxWidth,
} from "../src/utils/homeLayout";

// EXP-426: home has a small Privacy link that opens the game server's /privacy page in the app language, in the
// browser (no route is pushed). It shares the Photo Explorer label's row, in the strip right of the centred label and
// dice button, sized from the label as laid out, so it never covers them (a link under the label once pushed the dice
// into the Join game button). The Photo Explorer group keeps its place.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() };
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
let mockLang: "es" | "en" = "en";
jest.mock("../src/i18n", () => ({
  useI18n: () => ({ t: require(`../src/i18n/${mockLang}`).default, lang: mockLang }),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", saveUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), joinCodeDraft: "", setJoinCodeDraft: jest.fn(),
    socket: null, endSocket: jest.fn(), takeHomeNotice: () => null, takeRoomExit: () => false,
  }),
}));

import Index from "../app/index";

/** A narrow Android phone at font scale 1.3; the label width is a generous one for its 14 bold characters there */
const SCREEN = { width: 360, height: 640, scale: 2, fontScale: 1.3 };
const LABEL_WIDTH_AT_1_3 = 153;

let openURL: jest.SpyInstance;
beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockLang = "en";
  process.env.EXPO_PUBLIC_SERVER_URL = "http://localhost:3999";
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
  jest.spyOn(Dimensions, "get").mockReturnValue(SCREEN);
  Object.values(mockRouter).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_SERVER_URL;
  openURL.mockRestore();
  (Dimensions.get as jest.Mock).mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  await act(async () => { await Promise.resolve(); });
  return r;
}

const flatStyle = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

/** A position (`bottom`, `right`) of the closest absolutely placed view around (or at) the node */
const styleAround = (node: ReactTestInstance, key: "bottom" | "right"): number => {
  for (let n: ReactTestInstance | null = node; n; n = n.parent) {
    const value = flatStyle(n)[key];
    if (typeof value === "number") return value;
  }
  throw new Error(`no ${key} around it`);
};
const bottomOf = (node: ReactTestInstance) => styleAround(node, "bottom");

/** The pressable around the Photo Explorer label */
const photoExplorerLabel = (root: ReactTestInstance, label: string) => {
  let n: ReactTestInstance | null = root.find((node) => node.type === Text && node.props.children === label);
  while (n && typeof n.props.onLayout !== "function") n = n.parent;
  if (!n) throw new Error("the Photo Explorer label is not measured");
  return n;
};

/** Lays out the Photo Explorer label at this width (what onLayout reports on the device) */
const layOutLabel = (root: ReactTestInstance, label: string, width: number) =>
  act(() => {
    photoExplorerLabel(root, label).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 26 } } });
  });

/** The native views of the privacy link */
const privacyLinks = (root: ReactTestInstance) =>
  root.findAll((n) => typeof n.type === "string" && n.props.testID === TEST_IDS.homePrivacyLink);

describe("Home: privacy policy link (EXP-426)", () => {
  it.each([["en", en], ["es", es]] as const)("%s: opens the server's policy in the app language, without a route", async (lang, t) => {
    mockLang = lang;
    const r = await mount();
    layOutLabel(r.root, t.photoExplorer, LABEL_WIDTH_AT_1_3);
    const [link] = privacyLinks(r.root);

    expect(link.props.accessibilityRole).toBe("link");
    expect(link.props.accessibilityLabel).toBe(t.privacyPolicy);
    expect(link.findByType(Text).props.children).toBe(t.privacy);
    const pressable = r.root.find((n) => n.props.testID === TEST_IDS.homePrivacyLink && typeof n.props.onPress === "function");
    await act(async () => { await pressable.props.onPress(); });

    expect(openURL).toHaveBeenCalledWith(`http://localhost:3999/privacy?lang=${lang}`);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("waits for the label's layout, so it is never drawn without its bound", async () => {
    const r = await mount();
    expect(privacyLinks(r.root)).toHaveLength(0);
    layOutLabel(r.root, en.photoExplorer, LABEL_WIDTH_AT_1_3);
    expect(privacyLinks(r.root)).toHaveLength(1);
    act(() => r.unmount());
  });

  it.each([["en", en], ["es", es]] as const)(
    "%s: on a 360 pt phone at font 1.3 it stays in the strip right of the label and dice, on their row",
    async (lang, t) => {
      mockLang = lang;
      const r = await mount();
      layOutLabel(r.root, t.photoExplorer, LABEL_WIDTH_AT_1_3);
      const [link] = privacyLinks(r.root);
      const { maxWidth } = flatStyle(link);
      const linkLeft = SCREEN.width - PRIVACY_LINK_RIGHT - maxWidth;

      expect(maxWidth).toBe(privacyLinkMaxWidth(SCREEN.width, LABEL_WIDTH_AT_1_3));
      expect(linkLeft).toBeGreaterThan(SCREEN.width / 2 + Math.max(LABEL_WIDTH_AT_1_3, PHOTO_EXPLORER_BUTTON_SIZE) / 2);
      expect(bottomOf(link)).toBe(PRIVACY_LINK_BOTTOM);
      expect(styleAround(link, "right")).toBe(PRIVACY_LINK_RIGHT);
      act(() => r.unmount());
    }
  );

  it("its height is bounded: padding, line count and font scale are the ones homeLayout counts", async () => {
    const r = await mount();
    layOutLabel(r.root, en.photoExplorer, LABEL_WIDTH_AT_1_3);
    const [link] = privacyLinks(r.root);
    const text = link.findByType(Text);

    expect(flatStyle(link)).toMatchObject({ paddingTop: PRIVACY_LINK_PADDING_Y, paddingBottom: PRIVACY_LINK_PADDING_Y });
    expect(flatStyle(text).lineHeight).toBe(PRIVACY_LINK_LINE_HEIGHT);
    expect(text.props.numberOfLines).toBe(PRIVACY_LINK_MAX_LINES);
    expect(text.props.maxFontSizeMultiplier).toBe(PRIVACY_LINK_MAX_FONT_SCALE);
    // A taller touch area than its short text, never stretched sideways towards the label
    expect(link.props.hitSlop).toEqual({ top: 12, bottom: 12 });
    expect(link.props.hitSlop).toBe(PRIVACY_LINK_HIT_SLOP);
    act(() => r.unmount());
  });

  it("Photo Explorer keeps its place and size (label 60, dice 88, a 44 pt icon in 12 pt padding)", async () => {
    const r = await mount();
    const dice = r.root.findAll((n) => typeof n.type === "string" && n.props.testID === TEST_IDS.ownPhotosButton)[0];

    expect(bottomOf(photoExplorerLabel(r.root, en.photoExplorer))).toBe(PHOTO_EXPLORER_LABEL_BOTTOM);
    expect(bottomOf(dice)).toBe(PHOTO_EXPLORER_BUTTON_BOTTOM);
    expect([PHOTO_EXPLORER_LABEL_BOTTOM, PHOTO_EXPLORER_BUTTON_BOTTOM]).toEqual([60, 88]);
    const padding = PHOTO_EXPLORER_BUTTON_PADDING;
    expect(flatStyle(dice)).toMatchObject({ paddingTop: padding, paddingBottom: padding, paddingLeft: padding, paddingRight: padding });
    expect(r.root.find((n) => n.props.name === "dice").props.size).toBe(PHOTO_EXPLORER_ICON_SIZE);
    act(() => r.unmount());
  });
});
