import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-200 / EXP-142: the root layout hides the dev client Tools button at module load and retries
// once after the first render, in case the dev menu was not initialized yet.

jest.mock("../app/utils/devToolsButton", () => ({ hideDevToolsButton: jest.fn().mockResolvedValue(undefined) }));
// Fonts not loaded: the layout renders nothing, so no providers or navigator are needed
jest.mock("expo-font", () => ({ useFonts: () => [false] }));
jest.mock("expo-router", () => ({ Stack: () => null }));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("expo-screen-orientation", () => ({ lockAsync: jest.fn(), OrientationLock: { PORTRAIT_UP: 1 } }));
jest.mock("expo-device", () => ({ DeviceType: { PHONE: 1 }, getDeviceTypeAsync: jest.fn().mockResolvedValue(1) }));
jest.mock("react-native-reanimated", () => ({}));
jest.mock("@/app/providers/PhotoContext", () => ({ PhotoProvider: () => null }));
jest.mock("../app/providers/GameContext", () => ({ GameProvider: () => null }));
jest.mock("../app/providers/BackgroundContext", () => ({ BackgroundProvider: () => null }));
jest.mock("../app/i18n", () => ({ I18nProvider: () => null }));

import { hideDevToolsButton } from "../app/utils/devToolsButton";
import RootLayout from "../app/_layout";

describe("root layout hides the dev client Tools button", () => {
  it("hides it at module load and retries after the first render", async () => {
    expect(hideDevToolsButton).toHaveBeenCalledTimes(1);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RootLayout />);
    });

    expect(hideDevToolsButton).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});
