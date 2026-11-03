import React from "react";
import TestRenderer, { act, ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import { AccessibilityInfo, Animated, Image, Platform, ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";

// Owner redesign + EXP-135: the first-run photo-access screen is a minimalist, on-brand explainer (blurred photo
// backdrop, fanned "polaroids" with the 😳 mascot, a short promise of what happens with the photos and one red
// "Continue"), instead of an amber "Warning" with screenshots of another app's permission dialog.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));
const mockHandleContinue = jest.fn();
jest.mock("@/src/providers/PhotoContext", () => ({ usePhotoContext: () => ({ handleContinue: mockHandleContinue }) }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("../src/components/LanguageToggle", () => () => null);
// EXP-192: a tall gesture-bar inset, so the test can tell whether the scroll content clears it
const MOCK_BOTTOM_INSET = 48;
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return {
    SafeAreaView: (props: any) => <View {...props} />,
    useSafeAreaInsets: () => ({ top: 24, bottom: MOCK_BOTTOM_INSET, left: 0, right: 0 }),
  };
});

const en = require("../src/i18n/en").default;
const es = require("../src/i18n/es").default;
let mockT = en;
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT }) }));

import InitialScreen from "../app/screens/InitialScreen";
import PhotoFanHero, { CARD_BLUR_RADIUS, FAN_CARDS, HERO_HEIGHT } from "../src/components/PhotoFanHero";
import { TEST_IDS } from "../src/utils/testIds";
import { resetReduceMotionSettingForTests, useReduceMotion, useReduceMotionSetting } from "../src/hooks/useReduceMotion";
import { BRAND_GRADIENT, brandTitleShadow } from "../src/theme/brand";

// Rendered trees are unmounted after each test, so no entrance animation outlives it
const mounted: ReactTestRenderer[] = [];
const render = async (element: React.ReactElement = <InitialScreen />) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(element);
  });
  mounted.push(tree);
  return tree;
};

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((n) => [].concat(n.props.children).join(""));
const byTestID = (tree: ReactTestRenderer, id: string) =>
  tree.root.find((n) => n.props.testID === id && typeof n.type !== "string");
const flat = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
// The fanned cards and the emoji badge are the Animated.Views of the hero
const heroMotion = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => typeof n.type === "string" && Array.isArray(flat(n)?.transform)).map((n) => flat(n).transform);

const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });

let reduceMotion = false;
beforeEach(() => {
  jest.useFakeTimers();
  mockT = en;
  reduceMotion = false;
  // The setting is cached for the app's lifetime: every test starts from a cold app that has not asked yet
  resetReduceMotionSettingForTests();
  mockReplace.mockReset();
  mockHandleContinue.mockReset().mockResolvedValue(undefined);
  jest.spyOn(Haptics, "impactAsync").mockResolvedValue();
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockImplementation(() => Promise.resolve(reduceMotion));
});
afterEach(async () => {
  act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
  setOS(realOS);
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe("InitialScreen copy", () => {
  it.each([
    ["es", es, "TU GALERÍA\nES EL JUEGO"],
    ["en", en, "YOUR GALLERY\nIS THE GAME"],
  ])("shows the %s title, subtitle, the three promises, the CTA and the footnote", async (_lang, t, title) => {
    mockT = t;
    const tree = await render();
    expect(texts(tree)).toEqual([
      "😳",
      title,
      t.initialSubtitle,
      t.initialPointRandom,
      t.initialPointRoom,
      t.initialPointDeleted,
      t.continue_,
      t.initialFootnote,
    ]);
    expect(byTestID(tree, TEST_IDS.initialTitle).props.children).toBe(title);
  });

  it("has the spec wording", () => {
    expect([es.initialSubtitle, es.initialPointRandom, es.initialPointRoom, es.initialPointDeleted, es.initialFootnote]).toEqual([
      "En tu turno sale una foto al azar de tu galería. Los demás adivinan de quién es.",
      "Una foto al azar, solo en tus turnos",
      "Solo la ve tu sala",
      "Se borra al acabar la partida",
      "Puedes compartir todas tus fotos o solo algunas.",
    ]);
    expect([en.initialSubtitle, en.initialPointRandom, en.initialPointRoom, en.initialPointDeleted, en.initialFootnote]).toEqual([
      "On your turn a random photo from your gallery appears. Everyone else guesses whose it is.",
      "One random photo, only on your turns",
      "Only your room sees it",
      "Deleted when the game ends",
      "You can share all your photos or just some.",
    ]);
    expect([es.continue_, en.continue_]).toEqual(["Continuar", "Continue"]);
  });

  it.each([["es", es], ["en", en]])("has no warning banner or system-dialog instructions (%s)", async (_lang, t) => {
    mockT = t;
    const shown = texts(await render()).join(" ");
    expect(shown).not.toMatch(/aviso|warning|⚠️|permiso necesario|required permission|allow all|permitir todo/i);
  });

  it("uses the brand display font for the title, with the logo shadow scaled to 36 px", async () => {
    const tree = await render();
    expect(flat(byTestID(tree, TEST_IDS.initialTitle))).toMatchObject({
      fontFamily: "IconFont",
      fontSize: 36,
      textShadowColor: "rgba(0, 0, 0, 0.5)",
      textShadowOffset: { width: 4, height: 2 },
      textShadowRadius: 2,
    });
  });

  it("the CTA uses the brand red gradient", async () => {
    const tree = await render();
    const button = byTestID(tree, TEST_IDS.initialContinueButton);
    const gradient = tree.root.find((n) => n.props.colors === BRAND_GRADIENT && n.findAll((c) => c === button).length > 0);
    expect(gradient.props.colors).toEqual(["#9d0420", "#e9042e", "#9d0420"]);
  });

  // EXP-135: no screenshots of another app's permission dialog, only blurred backdrop/card photos
  it("shows no screenshot of a permission dialog", async () => {
    const tree = await render();
    const images = tree.root.findAllByType(Image);
    expect(images).toHaveLength(1 + FAN_CARDS.length);
    for (const image of images) expect(image.props.blurRadius).toBeGreaterThan(0);
    expect(() => require("../assets/images/PermissionRequestIOS.jpg")).toThrow();
    expect(() => require("../assets/images/galleryPermissionIMG.jpg")).toThrow();
    expect(() => require("../assets/animations/FingerAnimation.json")).toThrow();
  });
});

// EXP-275: on Android the title, shrink-wrapped by the centred column, was measured a hair narrower than it draws:
// «YOUR GALLERY» wrapped onto two lines inside a box measured for two, so «IS THE GAME» was cut off
describe("InitialScreen title never clips", () => {
  it.each([
    ["es", "ios", es],
    ["en", "ios", en],
    ["es", "android", es],
    ["en", "android", en],
  ])("spans the full column width and nothing caps its height (%s, %s)", async (_lang, os, t) => {
    setOS(os as typeof Platform.OS);
    mockT = t;
    const title = byTestID(await render(), TEST_IDS.initialTitle);
    const style = flat(title);
    expect(style.width).toBe("100%");
    expect(style.textAlign).toBe("center");
    for (const cap of ["height", "maxHeight", "overflow"]) expect(style).not.toHaveProperty(cap);
    expect(title.props.numberOfLines).toBeUndefined();
  });

  it.each([
    ["es", es, ["TU GALERÍA", "ES EL JUEGO"]],
    ["en", en, ["YOUR GALLERY", "IS THE GAME"]],
  ])("renders both lines of the %s title", async (_lang, t, lines) => {
    mockT = t;
    const title = byTestID(await render(), TEST_IDS.initialTitle);
    expect(String(title.props.children).split("\n")).toEqual(lines);
  });
});

describe("InitialScreen continue", () => {
  it("has exactly one action", async () => {
    const tree = await render();
    const buttons = tree.root.findAllByType(TouchableOpacity);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.testID).toBe(TEST_IDS.initialContinueButton);
  });

  it("taps lightly, remembers the screen was seen, asks for photo access and goes home", async () => {
    const order: string[] = [];
    mockHandleContinue.mockImplementation(async () => {
      order.push(`ask (seen=${await AsyncStorage.getItem("hasSeenInitialScreen")})`);
    });
    mockReplace.mockImplementation((path: string) => order.push(`replace ${path}`));
    const tree = await render();
    await act(async () => byTestID(tree, TEST_IDS.initialContinueButton).props.onPress());
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(order).toEqual(["ask (seen=true)", "replace /"]);
  });
});

describe("InitialScreen layout", () => {
  it("scroll content starts below the language toggle and is centred", async () => {
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    const content = StyleSheet.flatten(scroll.props.contentContainerStyle);
    expect(StyleSheet.flatten(scroll.props.style).flexGrow).toBe(1);
    expect(content.flexGrow).toBe(1);
    expect(content.justifyContent).toBe("center");
    // top-12 (48 px) + the toggle itself
    expect(content.paddingTop).toBeGreaterThanOrEqual(88);
  });

  // EXP-192 / EXP-196: on short gesture-nav Android phones a button at the end of the scroll content could be left
  // as a sliver above the gesture bar (Maestro then tapped the bar). "Continue" and the footnote sit in a fixed
  // footer outside the ScrollView, padded by the bottom inset; the frame itself does not pad the bottom edge.
  it("keeps Continue and the footnote in a fixed footer above the bottom inset", async () => {
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    const button = byTestID(tree, TEST_IDS.initialContinueButton);
    expect(scroll.findAll((n) => n === button)).toHaveLength(0);
    expect(scroll.findAllByType(Text).map((n) => n.props.children)).not.toContain(en.initialFootnote);

    const footer = tree.root.find(
      (n) => typeof n.type === "string" && n.findAll((c) => c === button).length > 0 && flat(n)?.paddingBottom !== undefined,
    );
    expect(flat(footer).paddingBottom).toBe(MOCK_BOTTOM_INSET + 16);
    expect(footer.findAllByType(Text).map((n) => n.props.children)).toContain(en.initialFootnote);

    const frame = tree.root.find((n) => n.props.testID === TEST_IDS.initialScreen && n.props.edges);
    expect(frame.props.edges).not.toContain("bottom");
  });
});

describe("PhotoFanHero motion", () => {
  const fannedOut = FAN_CARDS.map((c) => [{ translateX: c.offsetX }, { translateY: c.offsetY }, { rotate: `${c.rotateDeg}deg` }]);

  it("fans the cards out from a stack and pops the emoji in", async () => {
    const spring = jest.spyOn(Animated, "spring");
    const tree = await render(<PhotoFanHero animate />);
    const [first] = heroMotion(tree);
    expect(first).toEqual([{ translateX: 0 }, { translateY: 0 }, { rotate: "0deg" }]);
    expect(spring).toHaveBeenCalledTimes(2);
    expect(spring).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 1, useNativeDriver: true }));
  });

  it("with reduce motion shows the final state at once, without animating", async () => {
    const spring = jest.spyOn(Animated, "spring");
    const tree = await render(<PhotoFanHero animate={false} />);
    expect(spring).not.toHaveBeenCalled();
    const motion = heroMotion(tree);
    expect(motion.slice(0, FAN_CARDS.length)).toEqual(fannedOut);
    // The emoji badge sits on the front card at full size
    expect(motion[FAN_CARDS.length]).toEqual([{ scale: 1 }]);
  });

  it("the screen keeps the hero's space but waits for the system setting before animating", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockReturnValue(new Promise(() => {}));
    const spring = jest.spyOn(Animated, "spring");
    const tree = await render();
    expect(tree.root.findAllByType(PhotoFanHero)).toHaveLength(0);
    expect(tree.root.findAll((n) => typeof n.type === "string" && flat(n)?.height === HERO_HEIGHT)).toHaveLength(1);
    expect(spring).not.toHaveBeenCalled();
  });

  it("the screen animates the hero when motion is allowed", async () => {
    const tree = await render();
    expect(tree.root.findByType(PhotoFanHero).props.animate).toBe(true);
  });

  it("the screen follows the system reduce-motion setting", async () => {
    reduceMotion = true;
    const tree = await render();
    expect(tree.root.findByType(PhotoFanHero).props.animate).toBe(false);
    expect(heroMotion(tree).slice(0, FAN_CARDS.length)).toEqual(fannedOut);
  });
});

// EXP-275: Android blurs the decoded bitmap with a 2-pass box blur at half the radius, so the iOS radius left the
// centre card's faces recognisable there
describe("PhotoFanHero blur", () => {
  const cardImages = async (os: typeof Platform.OS) => {
    setOS(os);
    const tree = await render(<PhotoFanHero animate={false} />);
    return tree.root.findAllByType(Image);
  };

  it.each([
    ["ios", 8],
    ["android", 20],
  ] as const)("blurs every card on %s with radius %i", async (os, radius) => {
    const images = await cardImages(os);
    expect(images).toHaveLength(FAN_CARDS.length);
    for (const image of images) expect(image.props.blurRadius).toBe(radius);
  });

  it("decodes the cards at card size, so the radius blurs every photo alike whatever its resolution", async () => {
    for (const image of await cardImages("android")) expect(image.props.resizeMethod).toBe("resize");
  });

  it("Android blurs at least twice as hard as iOS to make up for its halved box blur", () => {
    expect(CARD_BLUR_RADIUS.android).toBeGreaterThanOrEqual(2 * CARD_BLUR_RADIUS.ios);
  });
});

describe("brandTitleShadow", () => {
  it.each([
    [96, { width: 10, height: 5 }, 3], // the home logo's own shadow
    [36, { width: 4, height: 2 }, 2],
    [12, { width: 1, height: 1 }, 2], // the blur never drops below 2 px
  ])("at %i px casts a %o offset with a %i px blur", (fontSize, offset, radius) => {
    expect(brandTitleShadow(fontSize)).toEqual({
      textShadowColor: "rgba(0, 0, 0, 0.5)",
      textShadowOffset: offset,
      textShadowRadius: radius,
    });
  });
});

describe("useReduceMotionSetting", () => {
  it("animates as usual when the system setting cannot be read", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockRejectedValue(new Error("unavailable"));
    const tree = await render();
    expect(tree.root.findByType(PhotoFanHero).props.animate).toBe(true);
  });

  it("is undefined until the system answers, while useReduceMotion reads false meanwhile", async () => {
    let answer!: (enabled: boolean) => void;
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const seen: [boolean | undefined, boolean][] = [];
    const Probe = () => { seen.push([useReduceMotionSetting(), useReduceMotion()]); return null; };
    await render(<Probe />);
    expect(seen.at(-1)).toEqual([undefined, false]);
    await act(async () => answer(true));
    expect(seen.at(-1)).toEqual([true, true]);
  });
});

describe("InitialScreen i18n", () => {
  it("es and en define the same keys, and the old warning copy is gone", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const removed of [
      "warning", "permissionExplanation", "requiredPermission", "allowAll", "howToEnableAndroid", "howToEnableIOS",
      "tapAllowAll", "tapToProceed",
    ]) {
      expect(en).not.toHaveProperty(removed);
      expect(es).not.toHaveProperty(removed);
    }
  });
});
