import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";

// EXP-308: "useI18n must be used within I18nProvider" crashed the home screen in a dev session. Every screen sits
// under I18nProvider, so the hook can only miss it when a Fast Refresh re-evaluates the i18n module and a new
// context replaces the one the mounted provider supplies. The context lives in its own module, which such an edit
// does not re-evaluate: two evaluations of i18n/index.tsx must still share it.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import * as i18nContextModule from "../src/i18n/context";

type I18nModule = typeof import("../src/i18n");

/**
 * A fresh evaluation of i18n/index.tsx, like the one a Fast Refresh edit to it (or to es.ts/en.ts) leaves behind.
 * React and the context module are not re-evaluated by such an edit, so both stay shared.
 */
const loadI18nModule = (): I18nModule => {
  let mod!: I18nModule;
  jest.isolateModules(() => {
    jest.doMock("react", () => React);
    jest.doMock("../src/i18n/context", () => i18nContextModule);
    mod = require("../src/i18n");
  });
  return mod;
};

const mockLocale = (locale: string) =>
  jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
    () => ({ resolvedOptions: () => ({ locale }) }) as unknown as Intl.DateTimeFormat,
  );

afterEach(() => {
  jest.restoreAllMocks();
});

describe("I18n context identity", () => {
  it("a provider from one evaluation of the i18n module serves useI18n from a re-evaluated one", async () => {
    mockLocale("es-ES");
    const mountedModule = loadI18nModule();
    const refreshedModule = loadI18nModule();
    const Probe = () => {
      const { lang, t, setLang } = refreshedModule.useI18n();
      return <Text onPress={() => setLang("en")}>{`${lang}:${t.cancel}`}</Text>;
    };

    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(<mountedModule.I18nProvider><Probe /></mountedModule.I18nProvider>);
    });
    const label = () => r.root.findByType(Text).props.children;
    expect(label()).toBe("es:Cancelar");

    await act(async () => r.root.findByType(Text).props.onPress());
    expect(label()).toBe("en:Cancel");
    act(() => r.unmount());
  });

  it("useI18n still throws when no provider is mounted", () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const { useI18n } = loadI18nModule();
    const Probe = () => <Text>{useI18n().lang}</Text>;

    expect(() => act(() => { TestRenderer.create(<Probe />); }))
      .toThrow("useI18n must be used within I18nProvider");
  });
});
