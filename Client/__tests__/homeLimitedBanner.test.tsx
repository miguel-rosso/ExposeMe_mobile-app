import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { AppState, Text } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import { BRAND_RED } from "../app/theme/brand";
import en from "../app/i18n/en";
import es from "../app/i18n/es";

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
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
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
