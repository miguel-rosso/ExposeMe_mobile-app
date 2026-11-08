import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, AppState, BackHandler } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { recordTermsAccepted } from "../src/utils/termsAcceptance";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import Index from "../app/index";
import NotFound from "../app/+not-found";
import WaitingRoom from "../app/screens/WaitingRoom";
import GameScreen from "../app/screens/GameScreen";
import { GameProvider, useGameContext } from "../src/providers/GameContext";
import type { FakeSocket } from "../testUtils/fakeSocket";
import { openDeepLink, resetStack, routerCalls, StackScreens, stackPaths } from "../testUtils/stackRouter";
import { TEST_IDS } from "../src/utils/testIds";
import en from "../src/i18n/en";

// EXP-412: a link to a route the app doesn't have (exposeme://i18n/es, a mistyped or old link) opened expo-router's
// technical "Unmatched Route" screen, in English, with the URL and a link to the list of the app's routes. The app's
// own not-found screen (app/+not-found.tsx, which appRoutes.test checks such links resolve to) gives way to the screen
// under it: on home, which tells why in a translated notice, without stacking a second home (EXP-339); over a room's
// screen, which keeps its room and gets no notice (EXP-373). Real home, lobby, game screen, not-found screen and
// GameProvider in a native-like stack.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// Every socket the app opens, not connected until the test says so
const mockSockets: FakeSocket[] = [];
jest.mock("socket.io-client", () => ({
  io: () => {
    const { FakeSocket } = require("../testUtils/fakeSocket");
    const socket = new FakeSocket();
    socket.connected = false;
    mockSockets.push(socket);
    return socket;
  },
}));

jest.mock("expo-router", () => require("../testUtils/stackRouter").expoRouterMock);

// ── Screen dependencies ──

jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
    pickGamePhoto: jest.fn(),
    setPhotoUri: jest.fn(),
  }),
}));
jest.mock("@/src/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
// The lobby's Exit button (X), pressed through its onPress
jest.mock("@/src/components/CloseButton", () => "CloseButton");
jest.mock("@/src/components/AnimatedDot", () => () => null);
jest.mock("@/src/components/modals/AlertModal", () => () => null);
jest.mock("@/src/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/src/components/SuccessAlert", () => () => null);
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

let alertSpy: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
  jest.spyOn(BackHandler, "addEventListener").mockImplementation(() => ({ remove: () => {} }));
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });

const HOME = "/";
const LOBBY = "/screens/WaitingRoom";
const GAME = "/screens/GameScreen";
/** A link to a module that used to live under app/ (EXP-054): expo-router opens app/+not-found.tsx for it */
const UNKNOWN_LINK = "/i18n/es";
const ROOM = "ABC234";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };
const SCREENS = { [HOME]: Index, [LOBBY]: WaitingRoom, [GAME]: GameScreen, [UNKNOWN_LINK]: NotFound };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

let app: TestRenderer.ReactTestRenderer | null = null;
const fire = async (socket: FakeSocket, ev: string, ...args: unknown[]) => {
  await act(async () => { socket.fire(ev, ...args); });
  await flush();
};
const press = async (id: string) => {
  const pressable = app!.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function");
  await act(async () => { await pressable.props.onPress(); });
  await flush();
};
const codeInput = () =>
  app!.root.find((n) => n.props.testID === TEST_IDS.gameCodeInput && typeof n.props.onChangeText === "function");
const player = (username: string, isHost = false) => ({ username, points: 0, isHost, connected: true });
const roomOfGame = {
  success: true,
  room: { gameCode: ROOM, players: [player("alice", true), player("bob")], rounds: 5, started: false },
  rejoinToken: "tok-1",
};

const startApp = async () => {
  await act(async () => { app = TestRenderer.create(<GameProvider><StackScreens screens={SCREENS} /><Probe /></GameProvider>); });
  await flush();
};

const openUnknownLink = async () => {
  await act(async () => { openDeepLink(UNKNOWN_LINK, {}); });
  await flush();
};

/** bob joins ROOM from home's Search room: the lobby over home. Returns the room's socket. */
const inLobby = async () => {
  await press(TEST_IDS.joinGameButton);
  act(() => codeInput().props.onChangeText(ROOM));
  await press(TEST_IDS.searchRoomButton);
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await fire(socket, "connect");
  await fire(socket, "room-of-game", roomOfGame);
  expect(stackPaths()).toEqual([HOME, LOBBY]);
  return socket;
};

const pressExit = async () => {
  await act(async () => { app!.root.findByType("CloseButton" as any).props.onPress(); });
  await flush();
};

const noticesShown = () => alertSpy.mock.calls.map(([, message]) => message);

const expectStillInRoom = (socket: FakeSocket) => {
  expect(socket.disconnect).not.toHaveBeenCalled();
  expect(socket.emittedPayloads("leave-room")).toEqual([]);
  expect(ctx.socket).toBe(socket);
  expect(ctx.gameCode).toBe(ROOM);
};

// FlatList schedules cell updates on timers: keep them on fake timers
beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  await recordTermsAccepted();
  await AsyncStorage.setItem("username", "bob");
  mockSockets.length = 0;
  alertSpy.mockClear();
  resetStack();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("A link to a route the app doesn't have (EXP-412)", () => {
  it("cold start: back to the home under it, which tells why once", async () => {
    // The root layout anchors home under the link's screen
    openDeepLink(UNKNOWN_LINK, {});
    await startApp();

    expect(stackPaths()).toEqual([HOME]);
    expect(routerCalls).toEqual(["back"]);
    expect(noticesShown()).toEqual([en.unknownLinkNotice]);
  });

  it("from home: pops back to that same home (no second one stacked), which tells why", async () => {
    await startApp();

    await openUnknownLink();

    expect(stackPaths()).toEqual([HOME]);
    expect(routerCalls.at(-1)).toBe("back");
    expect(noticesShown()).toEqual([en.unknownLinkNotice]);
  });

  it("in the lobby: back to the lobby, still in the room, and no notice left for when the player leaves it", async () => {
    await startApp();
    const socket = await inLobby();

    await openUnknownLink();

    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expectStillInRoom(socket);
    await pressExit();
    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([]);
  });

  it("mid-game: back to the game, still in the room", async () => {
    await startApp();
    const socket = await inLobby();
    await fire(socket, "game-started", [player("alice", true), player("bob")]);
    expect(stackPaths()).toEqual([HOME, GAME]);

    await openUnknownLink();

    expect(stackPaths()).toEqual([HOME, GAME]);
    expectStillInRoom(socket);
    expect(noticesShown()).toEqual([]);
  });
});
