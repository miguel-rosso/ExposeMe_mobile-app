import React from "react";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import { Text } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ACCEPTED_TERMS_KEY,
  hasAcceptedCurrentTerms,
  recordTermsAccepted,
  TERMS_VERSION,
} from "../src/utils/termsAcceptance";
import { splitTemplate } from "../src/i18n/format";

// EXP-433 (DEC-058): before sharing anything (photos, chat, name) the player accepts the terms of use on the first
// screen. The device remembers the accepted version: a device that only passed the old onboarding (no terms), or
// accepted an older version, sees the first screen again, once.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  // Focus effects run on mount, and again on mockRefocus() (home focused again, e.g. back from a room)
  useFocusEffect: (effect: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockFocusEffects.add(effect);
      effect();
      return () => mockFocusEffects.delete(effect);
    }, [effect]);
  },
}));
const mockFocusEffects = new Set<() => void>();
const mockRefocus = () => mockFocusEffects.forEach((effect) => effect());
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => {
  const { Text } = require("react-native");
  return () => <Text>first-run screen</Text>;
});
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default, lang: "en" }) }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", saveUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), joinCodeDraft: "",
    setJoinCodeDraft: jest.fn(), requestNewRoom: jest.fn(), socket: null, endSocket: jest.fn(),
    takeHomeNotice: () => null, takeRoomExit: () => false,
  }),
}));

import Index from "../app/index";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("termsAcceptance", () => {
  it("a fresh install has not accepted the terms", async () => {
    await expect(hasAcceptedCurrentTerms()).resolves.toBe(false);
  });

  it("a device that only passed the old onboarding (no terms) has not accepted them", async () => {
    await AsyncStorage.setItem("hasSeenInitialScreen", "true");
    await expect(hasAcceptedCurrentTerms()).resolves.toBe(false);
  });

  it("a device that accepted an older version has to accept the current one", async () => {
    await AsyncStorage.setItem(ACCEPTED_TERMS_KEY, "2020-01-01");
    await expect(hasAcceptedCurrentTerms()).resolves.toBe(false);
  });

  it("remembers the current version once accepted", async () => {
    await recordTermsAccepted();
    expect(await AsyncStorage.getItem(ACCEPTED_TERMS_KEY)).toBe(TERMS_VERSION);
    await expect(hasAcceptedCurrentTerms()).resolves.toBe(true);
  });
});

describe("home's terms gate", () => {
  const texts = (tree: ReactTestRenderer) => tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(""));
  const renderHome = async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<Index />);
    });
    return tree;
  };
  const shownTexts = async () => {
    const tree = await renderHome();
    const shown = texts(tree);
    act(() => tree.unmount());
    return shown;
  };

  // A cold-start invite link opens the lobby over this home, still on the first-run screen; the invite dialog's Join
  // accepts the terms. Back home, it shows home, not the first-run screen again.
  it("reads the terms again when focused, once they were accepted on another screen", async () => {
    const tree = await renderHome();
    expect(texts(tree)).toContain("first-run screen");
    await recordTermsAccepted();
    await act(async () => mockRefocus());
    expect(texts(tree)).not.toContain("first-run screen");
    act(() => tree.unmount());
  });

  it("shows the first-run screen on a fresh install", async () => {
    expect(await shownTexts()).toContain("first-run screen");
  });

  it("shows the first-run screen once more to a device that passed the old onboarding without terms", async () => {
    await AsyncStorage.setItem("hasSeenInitialScreen", "true");
    expect(await shownTexts()).toContain("first-run screen");
  });

  it("goes straight to home once the current terms are accepted", async () => {
    await recordTermsAccepted();
    expect(await shownTexts()).not.toContain("first-run screen");
  });
});

describe("splitTemplate", () => {
  it("splits a translation at its placeholders, in order", () => {
    expect(splitTemplate("By continuing you accept the {terms} and the {privacy}")).toEqual([
      { text: "By continuing you accept the " },
      { placeholder: "terms" },
      { text: " and the " },
      { placeholder: "privacy" },
    ]);
  });

  it("drops empty text between adjacent placeholders and keeps a template without any as one piece", () => {
    expect(splitTemplate("{a}{b}.")).toEqual([{ placeholder: "a" }, { placeholder: "b" }, { text: "." }]);
    expect(splitTemplate("No links")).toEqual([{ text: "No links" }]);
  });
});
