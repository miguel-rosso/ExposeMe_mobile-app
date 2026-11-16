import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// EXP-122: with no saved language, follow the device (es-* → es, anything else → en);
// a saved choice always wins, and the onboarding offers the language toggle.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock("@/src/providers/PhotoContext", () => ({ usePhotoContext: () => ({ handleContinue: jest.fn() }) }));
jest.mock("@/src/components/CustomCarousel/CustomCarousel", () => () => null);
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = require("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { I18nProvider, useI18n, resolveInitialLang } from "../src/i18n";
import { TEST_IDS } from "../src/utils/testIds";
import LanguageToggle from "../src/components/LanguageToggle";
import InitialScreen from "../app/screens/InitialScreen";

const mockLocale = (locale: string) =>
  jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
    () => ({ resolvedOptions: () => ({ locale }) }) as unknown as Intl.DateTimeFormat,
  );

const LangProbe = () => <Text>{useI18n().lang}</Text>;

const renderLang = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<I18nProvider><LangProbe /></I18nProvider>);
  });
  const lang = r.root.findByType(Text).props.children;
  act(() => r.unmount());
  return lang;
};

afterEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe("resolveInitialLang", () => {
  it.each([
    ["es-ES", "es"], ["es-MX", "es"], ["es", "es"], ["es_AR", "es"],
    ["en-US", "en"], ["fr-FR", "en"], [undefined, "en"],
  ])("device %s → %s", (locale, expected) => {
    expect(resolveInitialLang(null, locale)).toBe(expected);
  });

  it("a saved choice wins over the device", () => {
    expect(resolveInitialLang("en", "es-ES")).toBe("en");
    expect(resolveInitialLang("es", "en-US")).toBe("es");
  });
});

describe("I18nProvider initial language", () => {
  it("uses Spanish on an es-ES device with nothing saved", async () => {
    mockLocale("es-ES");
    expect(await renderLang()).toBe("es");
  });

  it("uses English on en-US and fr-FR devices", async () => {
    mockLocale("en-US");
    expect(await renderLang()).toBe("en");
    mockLocale("fr-FR");
    expect(await renderLang()).toBe("en");
  });

  it("keeps the saved choice", async () => {
    mockLocale("es-ES");
    await AsyncStorage.setItem("app-lang", "en");
    expect(await renderLang()).toBe("en");
  });

  it("falls back to the device language when storage fails", async () => {
    mockLocale("es-MX");
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await renderLang()).toBe("es");
  });
});

describe("InitialScreen", () => {
  it("renders the language toggle", async () => {
    mockLocale("es-ES");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<I18nProvider><InitialScreen /></I18nProvider>);
    });
    expect(r.root.findAllByType(LanguageToggle)).toHaveLength(1);
    const toggle = r.root.find((n) => n.props.testID === TEST_IDS.languageToggle && !!n.props.onPress);
    expect(toggle.props.accessibilityLabel).toBe("Cambiar idioma");
    const title = () => r.root.find((n) => n.props.testID === TEST_IDS.initialTitle && n.type === Text);
    expect(title().props.children).toBe("TU GALERÍA\nES EL JUEGO");

    await act(async () => toggle.props.onPress());
    expect(title().props.children).toBe("YOUR GALLERY\nIS THE GAME");
    expect(await AsyncStorage.getItem("app-lang")).toBe("en");
    act(() => r.unmount());
  });
});
