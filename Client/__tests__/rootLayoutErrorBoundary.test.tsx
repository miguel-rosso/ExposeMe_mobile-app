import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-435: the root layout wires both error screens into expo-router: its ErrorBoundary export (expo-router renders it
// in place of the layout when the layout or a provider fails) and the root stack's unstable_screenErrorBoundary (in
// place of a screen that fails, inside every provider). Their behaviour is in errorScreen.test.tsx.

const mockStackProps: Record<string, unknown>[] = [];
jest.mock("expo-router", () => {
  const Stack = (props: Record<string, unknown>) => { mockStackProps.push(props); return null; };
  Stack.Screen = () => null;
  return { Stack };
});
jest.mock("../src/utils/devToolsButton", () => ({ hideDevToolsButton: jest.fn().mockResolvedValue(undefined) }));
jest.mock("expo-font", () => ({ useFonts: () => [true] }));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("expo-screen-orientation", () => ({ lockAsync: jest.fn(), OrientationLock: { PORTRAIT_UP: 1 } }));
jest.mock("expo-device", () => ({ DeviceType: { PHONE: 1 }, getDeviceTypeAsync: jest.fn().mockResolvedValue(1) }));
jest.mock("react-native-reanimated", () => ({}));
jest.mock("@/src/providers/PhotoContext", () => ({ PhotoProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/providers/GameContext", () => ({ GameProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/providers/BackgroundContext", () => ({ BackgroundProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/i18n", () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/components/ErrorScreen", () => ({ AppErrorBoundary: () => null, ScreenErrorBoundary: () => null }));

import RootLayout, { ErrorBoundary } from "../app/_layout";
import { AppErrorBoundary, ScreenErrorBoundary } from "../src/components/ErrorScreen";

describe("root layout error boundaries (EXP-435)", () => {
  it("exports the app's fallback as expo-router's ErrorBoundary", () => {
    expect(ErrorBoundary).toBe(AppErrorBoundary);
  });

  it("gives the root stack the screen error boundary", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RootLayout />);
    });

    expect(mockStackProps.at(-1)?.unstable_screenErrorBoundary).toBe(ScreenErrorBoundary);
    act(() => renderer.unmount());
  });
});
