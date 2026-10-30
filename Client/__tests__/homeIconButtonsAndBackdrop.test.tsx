import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Image, Text } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
import es from "../app/i18n/es";

// EXP-046: the home screen's icon-only buttons (clear the name, clear the room code, open the Photo Explorer) have a
// translated name for TalkBack / VoiceOver instead of being announced as a bare "button".
// EXP-283: the "Photo Explorer" text under the dice still opens it on tap, but screen readers only get the dice button.
// EXP-262: the blurred background is a single <Image blurRadius>, with no hidden ImageBlur layers under it.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("@/app/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/components/LimitedAccessBanner", () => () => null);
const mockBackground = 7;
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: mockBackground }) }));
let mockLang: "es" | "en" = "en";
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require(`../app/i18n/${mockLang}`).default }) }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", setUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), joinCodeDraft: "K7", setJoinCodeDraft: jest.fn(), socket: null, endSocket: jest.fn(),
  }),
}));

import Index from "../app/index";

/** The home background keeps the blur it had with ImageBlur */
const HOME_BACKDROP_BLUR_RADIUS = 3;

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockLang = "en";
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  await act(async () => { await Promise.resolve(); });
  return r;
}

/** The native view a screen reader announces with this name: exactly one, announced as a button */
const buttonLabelled = (root: ReactTestInstance, label: string) => {
  const matches = root.findAll((n) => typeof n.type === "string" && n.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  expect(matches[0].props.accessibilityRole).toBe("button");
  return matches[0];
};

const openJoinForm = (r: TestRenderer.ReactTestRenderer) =>
  act(() => { r.root.find((n) => n.props.testID === TEST_IDS.joinGameButton && typeof n.props.onPress === "function").props.onPress(); });

describe("Home: icon-only buttons have a screen reader name (EXP-046)", () => {
  it.each([["en", en], ["es", es]] as const)("%s: clear name and Photo Explorer dice", async (lang, t) => {
    mockLang = lang;
    const r = await mount();
    expect(buttonLabelled(r.root, t.clearUsername).props.testID).toBe(TEST_IDS.usernameClearButton);
    expect(buttonLabelled(r.root, t.photoExplorer).props.testID).toBe(TEST_IDS.ownPhotosButton);
    act(() => r.unmount());
  });

  it.each([["en", en], ["es", es]] as const)("%s: clear room code in the join form", async (lang, t) => {
    mockLang = lang;
    const r = await mount();
    await openJoinForm(r);
    buttonLabelled(r.root, t.clearGameCode);
    act(() => r.unmount());
  });

  it("the labels are translated, not the same text in both languages", () => {
    expect(es.clearUsername).not.toBe(en.clearUsername);
    expect(es.clearGameCode).not.toBe(en.clearGameCode);
  });
});

describe("Home: Photo Explorer is announced once (EXP-283)", () => {
  const ancestors = (node: ReactTestInstance) => {
    const list: ReactTestInstance[] = [];
    for (let n = node.parent; n; n = n.parent) list.push(n);
    return list;
  };

  it.each([["en", en], ["es", es]] as const)("%s: the label under the dice is tappable but hidden from screen readers", async (lang, t) => {
    mockLang = lang;
    const r = await mount();
    const label = r.root.find((n) => n.type === Text && n.props.children === t.photoExplorer);
    const hostAncestors = ancestors(label).filter((n) => typeof n.type === "string");
    // Not a second "Photo Explorer" button, and hidden together with its text on both platforms
    expect(hostAncestors.some((n) => n.props.accessibilityRole === "button")).toBe(false);
    const hidden = hostAncestors.find(
      (n) => n.props.importantForAccessibility === "no-hide-descendants" && n.props.accessibilityElementsHidden === true
    );
    expect(hidden).toBeDefined();
    expect(hidden!.props.accessible).toBe(false);
    // Still opens the Photo Explorer for sighted users (EXP-240)
    expect(ancestors(label).some((n) => typeof n.props.onPress === "function")).toBe(true);
    act(() => r.unmount());
  });
});

describe("Home: blurred background (EXP-262)", () => {
  it("is one blurred <Image> of the background, without ImageBlur", async () => {
    const r = await mount();
    const blurred = r.root.findAll((n) => n.type === Image && n.props.blurRadius !== undefined);
    expect(blurred).toHaveLength(1);
    expect(blurred[0].props).toMatchObject({ source: mockBackground, blurRadius: HOME_BACKDROP_BLUR_RADIUS, resizeMode: "cover" });
    expect(r.root.findAll((n) => typeof n.type === "function" && n.type.name === "ImageBlur").map((n) => n.type)).toEqual([]);
    act(() => r.unmount());
  });
});
