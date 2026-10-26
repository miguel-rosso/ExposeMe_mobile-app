import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-180 / EXP-036: the home screen shows the server's reason for sending us back (`message` param) in the
// user's language, never the raw English protocol text.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => {},
}));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("@/app/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/es").default }) }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", setUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), socket: null, endSocket: jest.fn(),
  }),
}));

import Index from "../app/index";
import es from "../app/i18n/es";

const mockAlert = jest.fn();
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  (global as unknown as { alert: typeof mockAlert }).alert = mockAlert;
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockAlert.mockClear();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const mountWithMessage = async (message?: string) => {
  mockParams = message === undefined ? {} : { message };
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  act(() => r.unmount());
};

describe("Home screen: server message after being sent back (EXP-180)", () => {
  it("shows 'Too many attempts' in Spanish for a Spanish UI", async () => {
    await mountWithMessage("Too many attempts");
    expect(mockAlert).toHaveBeenCalledWith(es.serverErrorTooManyAttempts);
    expect(mockAlert).not.toHaveBeenCalledWith("Too many attempts");
  });

  it("shows a generic Spanish message for unknown server text", async () => {
    await mountWithMessage("Some new server error");
    expect(mockAlert).toHaveBeenCalledWith(es.serverErrorUnknown);
  });

  it("shows nothing without a message", async () => {
    await mountWithMessage();
    expect(mockAlert).not.toHaveBeenCalled();
  });
});
