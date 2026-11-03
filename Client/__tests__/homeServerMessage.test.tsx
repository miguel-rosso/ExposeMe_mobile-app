import React from "react";
import TestRenderer, { act } from "react-test-renderer";

// EXP-180 / EXP-036: the home screen shows the server's reason for sending us back (the home notice the screen over
// it left in GameContext) in the user's language, never the raw English protocol text.
// EXP-221: the notice's title and button are translated too (no system "Alert" / "OK" around a Spanish message).
// EXP-339: the reason is never read from the route (a link like exposeme:///?message=… could fake a known notice).

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useLocalSearchParams: () => mockParams,
    // The screen is focused while mounted: run the callback like an effect
    useFocusEffect: (callback: () => void) => useEffect(() => callback(), [callback]),
  };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("@/app/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/components/LimitedAccessBanner", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
let mockLang: "es" | "en" = "es";
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require(`../app/i18n/${mockLang}`).default }) }));
// The home notice, taken once like GameContext's
let mockNotice: string | null = null;
const mockTakeHomeNotice = () => {
  const notice = mockNotice;
  mockNotice = null;
  return notice;
};
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", saveUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), socket: null, endSocket: jest.fn(),
    takeHomeNotice: mockTakeHomeNotice,
    takeRoomExit: () => false,
  }),
}));

import { Alert } from "react-native";
import Index from "../app/index";
import es from "../app/i18n/es";
import en from "../app/i18n/en";
import { KICKED_BY_HOST_MESSAGE } from "../app/utils/serverMessage";

let mockAlert: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockAlert.mockClear();
  mockLang = "es";
});

/** The notice's message text (second argument of Alert.alert). */
const shownMessage = () => mockAlert.mock.calls[0]?.[1];
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Home focused with `message` as its notice (or none), and `params` as its route's params. */
const mountWithMessage = async (message?: string, params: Record<string, string> = {}) => {
  mockNotice = message ?? null;
  mockParams = params;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  act(() => r.unmount());
};

describe("Home screen: server message after being sent back (EXP-180)", () => {
  it("shows 'Too many attempts' in Spanish for a Spanish UI", async () => {
    await mountWithMessage("Too many attempts");
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(shownMessage()).toBe(es.serverErrorTooManyAttempts);
  });

  it("shows a generic Spanish message for unknown server text", async () => {
    await mountWithMessage("Some new server error");
    expect(shownMessage()).toBe(es.serverErrorUnknown);
  });

  it("tells a player removed by the host why they are back, in Spanish (EXP-045)", async () => {
    await mountWithMessage(KICKED_BY_HOST_MESSAGE);
    expect(shownMessage()).toBe("El anfitrión te ha sacado de la sala.");
  });

  it("titles the notice and labels its button in Spanish (EXP-221)", async () => {
    await mountWithMessage(KICKED_BY_HOST_MESSAGE);
    expect(mockAlert).toHaveBeenCalledWith("Aviso", es.kickedByHost, [{ text: "Aceptar" }]);
  });

  it("titles the notice and labels its button in English (EXP-221)", async () => {
    mockLang = "en";
    await mountWithMessage("Game not found");
    expect(mockAlert).toHaveBeenCalledWith("Notice", en.serverErrorGameNotFound, [{ text: "OK" }]);
  });

  it("shows nothing without a message", async () => {
    await mountWithMessage();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("shows nothing for a message in its route params (a link to /?message=...): only a notice it was handed", async () => {
    await mountWithMessage(undefined, { message: KICKED_BY_HOST_MESSAGE });
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("shows its notice once, however often home renders", async () => {
    mockNotice = "Room is full";
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<Index />); });
    await act(async () => { r.update(<Index />); });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});
