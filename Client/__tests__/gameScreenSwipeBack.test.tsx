import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-335: the iOS back gesture (edge swipe, and full-screen swipe on iOS 26+) must not pop
// GameScreen: returning home closes the socket without leave-room and the server pauses the game.
// react-native-screens rejects every pop recognizer (edge, interactiveContentPop, full-screen pan)
// when the top screen has gestureEnabled=false, so that single option covers all of them.
// Android back (classic and predictive) goes through GameScreen's hardwareBackPress handler.

type ScreenProps = { name: string; options?: Record<string, unknown> };

jest.mock("expo-router", () => {
  const Stack = ({ children }: { children: React.ReactNode }) => children;
  Stack.Screen = jest.fn(() => null);
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

import { Stack } from "expo-router";
import RootLayout from "../app/_layout";

function renderedScreenOptions(name: string): Record<string, unknown> | undefined {
  const calls = (Stack.Screen as unknown as jest.Mock).mock.calls as [ScreenProps][];
  return calls.find(([props]) => props.name === name)?.[0].options;
}

// EXP-336: the same goes for the waiting room: a swipe home closed the socket without leave-room, so the server kept
// the player in the lobby as a lost connection (name taken, host role held for 15 s). Its close button is the way out;
// Android back runs it too (WaitingRoom's hardwareBackPress handler, waitingRoomLobby.test.tsx).
describe("Game flow routes block the back gesture", () => {
  it.each(["screens/GameScreen", "screens/WaitingRoom"])("disables the iOS swipe-back gesture on %s", async (route) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RootLayout />);
    });

    const options = renderedScreenOptions(route);
    expect(options).toBeDefined();
    expect(options?.gestureEnabled).toBe(false);
    act(() => renderer.unmount());
  });
});
