import React from "react";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import { Alert, Linking, Text, TouchableOpacity } from "react-native";
import { TEST_IDS } from "../src/utils/testIds";

// EXP-434: the privacy policy, terms of use, contact address and app version live on an Information screen that home
// always links to (they used to be on the permission guide only, which a player who grants photo access never sees).
// The policy and terms open the game server's /privacy and /terms pages in the app language; the Contact row opens a
// mailto to the build's EXPO_PUBLIC_CONTACT_EMAIL, hidden when the build has no valid address (EXP-426).

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() };
jest.mock("expo-router", () => ({ useRouter: () => mockRouter }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return {
    SafeAreaView: (props: any) => <View {...props} />,
    useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }),
  };
});
let mockVersion: string | undefined = "1.1.0";
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockVersion === undefined ? null : { version: mockVersion };
    },
  },
}));

const en = require("../src/i18n/en").default;
const es = require("../src/i18n/es").default;
let mockT = en;
let mockLang: "en" | "es" = "en";
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT, lang: mockLang }) }));
const InfoScreen = require("../app/screens/InfoScreen").default;

const SERVER = "http://localhost:3999";
const EMAIL = "contact@example.com";

const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<InfoScreen />);
  });
  return tree;
};
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(""));
// The testID is forwarded down from the rows to their touchables and host views: match the element that takes it
const byTestID = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((n) => n.props.testID === id && (n.type === TouchableOpacity || n.type === Text))[0];
const press = async (tree: ReactTestRenderer, id: string) => {
  await act(async () => {
    await byTestID(tree, id).props.onPress();
  });
};

describe("InfoScreen (EXP-434)", () => {
  const saved = { server: process.env.EXPO_PUBLIC_SERVER_URL, email: process.env.EXPO_PUBLIC_CONTACT_EMAIL };
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    mockT = en;
    mockLang = "en";
    mockVersion = "1.1.0";
    process.env.EXPO_PUBLIC_SERVER_URL = SERVER;
    delete process.env.EXPO_PUBLIC_CONTACT_EMAIL;
    openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    Object.values(mockRouter).forEach((fn) => fn.mockClear());
  });
  afterEach(() => {
    openURL.mockRestore();
    for (const [key, value] of [["EXPO_PUBLIC_SERVER_URL", saved.server], ["EXPO_PUBLIC_CONTACT_EMAIL", saved.email]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("the policy and terms rows open the server's pages in the app language (%s)", async (lang, t) => {
    mockT = t;
    mockLang = lang;
    const tree = await render();

    expect(texts(tree)).toEqual(expect.arrayContaining([t.information, t.privacyPolicy, t.termsOfUsePage]));
    for (const [id, label] of [[TEST_IDS.infoPrivacyLink, t.privacyPolicy], [TEST_IDS.infoTermsLink, t.termsOfUsePage]]) {
      expect(byTestID(tree, id).props.accessibilityRole).toBe("link");
      expect(byTestID(tree, id).props.accessibilityLabel).toBe(label);
    }
    await press(tree, TEST_IDS.infoPrivacyLink);
    await press(tree, TEST_IDS.infoTermsLink);
    expect(openURL.mock.calls).toEqual([[`${SERVER}/privacy?lang=${lang}`], [`${SERVER}/terms?lang=${lang}`]]);
  });

  it.each([undefined, "not-an-email"])("there is no Contact row without a valid address (%p)", async (email) => {
    if (email !== undefined) process.env.EXPO_PUBLIC_CONTACT_EMAIL = email;
    const tree = await render();

    expect(byTestID(tree, TEST_IDS.infoContactLink)).toBeUndefined();
    expect(texts(tree)).not.toContain(en.contactUs);
  });

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("the Contact row shows the build's address and opens a mail to it (%s)", async (lang, t) => {
    mockT = t;
    mockLang = lang;
    process.env.EXPO_PUBLIC_CONTACT_EMAIL = EMAIL;
    const tree = await render();
    const row = byTestID(tree, TEST_IDS.infoContactLink);

    expect(row.props.accessibilityRole).toBe("link");
    expect(row.props.accessibilityLabel).toBe(`${t.contactUs}: ${EMAIL}`);
    expect(texts(tree)).toEqual(expect.arrayContaining([t.contactUs, EMAIL]));
    await press(tree, TEST_IDS.infoContactLink);
    expect(openURL).toHaveBeenCalledWith(`mailto:${EMAIL}`);
  });

  it("shows the address when no mail app can open it", async () => {
    process.env.EXPO_PUBLIC_CONTACT_EMAIL = EMAIL;
    openURL.mockRejectedValue(new Error("No Activity found to handle Intent"));
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tree = await render();

    await press(tree, TEST_IDS.infoContactLink);
    expect(alert).toHaveBeenCalledWith(en.contactUs, EMAIL);
    alert.mockRestore();
    warn.mockRestore();
  });

  it.each([
    ["en", en, "Version 1.1.0"],
    ["es", es, "Versión 1.1.0"],
  ] as const)("shows the app version from the build's config (%s)", async (_lang, t, shown) => {
    mockT = t;
    const tree = await render();
    expect([].concat(byTestID(tree, TEST_IDS.infoVersion).props.children).join("")).toBe(shown);
  });

  it("shows no version line when the build has no app config", async () => {
    mockVersion = undefined;
    const tree = await render();
    expect(byTestID(tree, TEST_IDS.infoVersion)).toBeUndefined();
  });

  it("Back pops to the home that opened it", async () => {
    const tree = await render();
    await press(tree, TEST_IDS.infoBackButton);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith("/");
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("the labels are translated", () => {
    for (const key of ["information", "privacyPolicy", "termsOfUsePage", "contactUs", "appVersion"]) {
      expect(es[key]).not.toBe(en[key]);
    }
  });
});
