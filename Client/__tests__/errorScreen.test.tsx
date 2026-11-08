import React from "react";
import { BackHandler, Text } from "react-native";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
// expo-router's own boundary, the one that renders a route's ErrorBoundary / the stack's unstable_screenErrorBoundary
import { Try } from "expo-router/build/views/Try";
import { AppErrorBoundary, ScreenErrorBoundary } from "../src/components/ErrorScreen";
import { I18nProvider } from "../src/i18n";
import { GameProvider, useGameContext } from "../src/providers/GameContext";
import { FakeSocket } from "../testUtils/fakeSocket";
import { resetStack, routerCalls, stackPaths, stackRouter, StackScreens } from "../testUtils/stackRouter";
import { TEST_IDS } from "../src/utils/testIds";
import es from "../src/i18n/es";
import en from "../src/i18n/en";

// EXP-435: a render error that reached no error boundary closed the app in a store build, and the player lost their
// seat as a lost connection. A screen that fails now shows a translated error screen in its place (Retry, Back to home,
// which leaves the room first); the root layout's fallback covers the app when a provider fails. Real I18nProvider,
// GameProvider and expo-router's Try, in a native-like stack.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockSocket = new (require("../testUtils/fakeSocket").FakeSocket)() as FakeSocket;
jest.mock("socket.io-client", () => ({ io: () => mockSocket }));
jest.mock("expo-router", () => require("../testUtils/stackRouter").expoRouterMock);
// Try hides the splash screen when it catches an error
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));

const HOME = "/";
const LOBBY = "/screens/WaitingRoom";
const ROOM = "ABC234";
const REJOIN_TOKEN = JSON.stringify({ gameCode: ROOM, username: "bob", token: "tok-1" });

/** Which screens throw while rendering, by path */
const failing = new Set<string>();
const screen = (path: string) => () => {
  if (failing.has(path)) throw new Error(`${path} failed to render`);
  return <Text testID={`screen-${path}`}>{path}</Text>;
};
/** A route as expo-router renders it under the root stack's unstable_screenErrorBoundary */
const route = (path: string) => {
  const Screen = screen(path);
  return () => (
    <Try catch={ScreenErrorBoundary}>
      <Screen />
    </Try>
  );
};
const SCREENS = { [HOME]: route(HOME), [LOBBY]: route(LOBBY) };

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

let app: TestRenderer.ReactTestRenderer | null = null;
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const has = (id: string) => app!.root.findAll((n) => n.props.testID === id && typeof n.type === "string").length > 0;
const texts = () => app!.root.findAllByType(Text).map((n) => n.props.children);
const press = async (id: string) => {
  const pressable = app!.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function");
  await act(async () => { pressable.props.onPress(); });
  await flush();
};

const startApp = async () => {
  await act(async () => {
    app = TestRenderer.create(
      <I18nProvider>
        <GameProvider>
          <StackScreens screens={SCREENS} />
          <Probe />
        </GameProvider>
      </I18nProvider>
    );
  });
  await flush();
};

/** bob in ROOM's lobby, over home */
const inLobby = async () => {
  await act(async () => {
    ctx.startSocket();
    ctx.setGameCode(ROOM);
    stackRouter.push(LOBBY);
  });
  await flush();
};

// Android back: the handlers subscribed right now, the latest first, as React Native calls them
type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
const BACK_PRESS = { type: "hardwareBackPress", timeStamp: 0 };
let backListeners: BackListener[] = [];
/** Presses Android back; whether a handler took it (false: the native stack pops, or the app closes on home) */
const pressBack = async () => {
  let consumed = false;
  await act(async () => { consumed = [...backListeners].reverse().some((listener) => listener(BACK_PRESS)); });
  await flush();
  return consumed;
};

let consoleError: jest.SpyInstance;
beforeEach(async () => {
  jest.useFakeTimers();
  // React reports every error a boundary catches; keep the output quiet and look at the app's own report
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  backListeners = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
    backListeners.push(listener);
    return { remove: () => { backListeners = backListeners.filter((l) => l !== listener); } };
  });
  await AsyncStorage.clear();
  await AsyncStorage.setItem("app-lang", "es");
  await AsyncStorage.setItem("username", "bob");
  await AsyncStorage.setItem("rejoinToken", REJOIN_TOKEN);
  failing.clear();
  mockSocket.reset();
  resetStack();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const appErrorReports = () =>
  consoleError.mock.calls.filter(([message]) => message === "Render error caught by the error screen:");

describe("a screen that fails to render (EXP-435)", () => {
  it("shows the translated error screen in its place and reports the error, without leaving the room", async () => {
    await startApp();
    failing.add(LOBBY);
    await inLobby();

    expect(has(TEST_IDS.errorScreen)).toBe(true);
    expect(texts()).toEqual(expect.arrayContaining([es.errorScreenTitle, es.tryAgain, es.errorScreenHome]));
    expect(appErrorReports().map(([, error]) => error.message)).toEqual([`${LOBBY} failed to render`]);
    expect(mockSocket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.gameCode).toBe(ROOM);
  });

  it("Retry renders the screen again, still in the room", async () => {
    await startApp();
    failing.add(LOBBY);
    await inLobby();

    failing.delete(LOBBY);
    await press(TEST_IDS.errorScreenRetry);

    expect(has(TEST_IDS.errorScreen)).toBe(false);
    expect(has(`screen-${LOBBY}`)).toBe(true);
    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(mockSocket.emittedPayloads("leave-room")).toHaveLength(0);
    expect(ctx.socket).toBe(mockSocket);
  });

  it("Back to home leaves the room (leave-room) and pops to the home under it", async () => {
    await startApp();
    failing.add(LOBBY);
    await inLobby();

    await press(TEST_IDS.errorScreenHome);

    expect(mockSocket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(routerCalls.at(-1)).toBe(`dismissTo ${HOME}`);
    expect(stackPaths()).toEqual([HOME]);
    expect(has(`screen-${HOME}`)).toBe(true);
    expect(ctx.socket).toBeNull();
    expect(ctx.gameCode).toBeNull();
  });

  it("home failing: Back to home renders it again, leaving nothing and keeping the stored rejoin token", async () => {
    failing.add(HOME);
    await startApp();
    expect(has(TEST_IDS.errorScreen)).toBe(true);

    failing.delete(HOME);
    await press(TEST_IDS.errorScreenHome);

    expect(has(`screen-${HOME}`)).toBe(true);
    expect(stackPaths()).toEqual([HOME]);
    expect(routerCalls).toEqual([]);
    expect(mockSocket.emitted).toEqual([]);
    expect(await AsyncStorage.getItem("rejoinToken")).toBe(REJOIN_TOKEN);
  });

  // The failed screen's own back handler (the game's Exit question, the lobby's Exit) is gone with it: a plain pop
  // would reach home without a leave, and home would just close the socket (a lost connection: the game pauses)
  it("Android back on a room screen's error screen is Back to home: one leave-room, then home", async () => {
    await startApp();
    failing.add(LOBBY);
    await inLobby();

    expect(await pressBack()).toBe(true);

    expect(mockSocket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(routerCalls.at(-1)).toBe(`dismissTo ${HOME}`);
    expect(stackPaths()).toEqual([HOME]);
    expect(ctx.socket).toBeNull();
  });

  it("Android back on home's error screen still leaves the app", async () => {
    failing.add(HOME);
    await startApp();
    expect(has(TEST_IDS.errorScreen)).toBe(true);

    expect(await pressBack()).toBe(false);
    expect(mockSocket.emitted).toEqual([]);
    expect(routerCalls).toEqual([]);
  });
});

// The root fallback replaces the whole app, GameProvider included: its socket must not stay open with nobody behind it
describe("GameProvider going away (EXP-435)", () => {
  it("closes its socket without leaving the room, so the stored rejoin token still gets the seat back", async () => {
    await startApp();
    await inLobby();

    act(() => app!.unmount());
    app = null;
    await flush();

    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(mockSocket.listenerCount("room-of-game")).toBe(0);
    expect(mockSocket.emittedPayloads("leave-room")).toEqual([]);
    expect(await AsyncStorage.getItem("rejoinToken")).toBe(REJOIN_TOKEN);
  });
});

describe("the app failing outside the screens: the root layout's fallback (EXP-435)", () => {
  const Broken = () => { throw new Error("provider failed"); };
  let broken = true;
  const MaybeBroken = () => (broken ? <Broken /> : <Text testID="app">app</Text>);

  const renderRoot = async () => {
    await act(async () => {
      app = TestRenderer.create(
        <Try catch={AppErrorBoundary}>
          <MaybeBroken />
        </Try>
      );
    });
  };

  it("speaks the device language (outside I18nProvider), reports the error and offers only Retry", async () => {
    jest.spyOn(Intl, "DateTimeFormat").mockReturnValue({ resolvedOptions: () => ({ locale: "es-ES" }) } as any);
    broken = true;
    await renderRoot();

    expect(texts()).toEqual(expect.arrayContaining([es.errorScreenTitle, es.errorScreenMessage, es.tryAgain]));
    expect(has(TEST_IDS.errorScreenHome)).toBe(false);
    expect(appErrorReports().map(([, error]) => error.message)).toEqual(["provider failed"]);
  });

  it("Retry renders the app again", async () => {
    jest.spyOn(Intl, "DateTimeFormat").mockReturnValue({ resolvedOptions: () => ({ locale: "en-US" }) } as any);
    broken = true;
    await renderRoot();
    expect(texts()).toEqual(expect.arrayContaining([en.errorScreenTitle]));

    broken = false;
    await press(TEST_IDS.errorScreenRetry);

    expect(has("app")).toBe(true);
    expect(has(TEST_IDS.errorScreen)).toBe(false);
  });
});
