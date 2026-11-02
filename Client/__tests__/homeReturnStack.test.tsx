import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, AppState, BackHandler } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import Index from "../app/index";
import WaitingRoom from "../app/screens/WaitingRoom";
import GameScreen from "../app/screens/GameScreen";
import SettingsInstructionsScreen from "../app/screens/SettingsInstructionsScreen";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import type { FakeSocket } from "../testUtils/fakeSocket";
import { openDeepLink, resetStack, routerCalls, StackScreens, stackPaths } from "../testUtils/stackRouter";
import { TEST_IDS } from "../app/utils/testIds";
import { pressInviteJoin } from "../testUtils/inviteConfirm";
import { KICKED_BY_HOST_MESSAGE } from "../app/utils/serverMessage";
import en from "../app/i18n/en";

// EXP-339: home stays mounted at the bottom of the stack under the waiting room and the game screen. Every way back
// (Exit, a refused join, kicked, the settings instructions' Back) pops to that same home instead of stacking a second
// one over it, whose Android back then reopened the old one (join panel and all). Home shows the server's reason on
// that same screen, each time it gets one, handed over in memory: a link to home with a message shows nothing. And
// home's own Android back only acts while home is focused: hidden under the lobby, it took the press meant for the
// lobby's Exit. Real home, lobby, game screen, settings instructions and GameProvider in a native-like stack.

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
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/components/LimitedAccessBanner", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
const GALLERY_OK = { status: "ok", limited: false, canAskAgain: true };
// Photo access denied for good: home's gallery gate offers "How to enable" (the settings instructions)
const GALLERY_DENIED_FOR_GOOD = { status: "denied", limited: false, canAskAgain: false };
let mockGalleryAccess = GALLERY_OK;
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => mockGalleryAccess,
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
    pickGamePhoto: jest.fn(),
    setPhotoUri: jest.fn(),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("@/assets/images/PermInstructions1.jpg", () => "PermInstructions1", { virtual: true });
jest.mock("@/assets/images/PermInstructions2.jpg", () => "PermInstructions2", { virtual: true });
jest.mock("@/assets/images/PermInstructions3.jpg", () => "PermInstructions3", { virtual: true });
jest.mock("@/assets/images/IOSPermInstruction2.jpg", () => "IOSPermInstruction2", { virtual: true });
jest.mock("@/assets/images/IOSPermInstruction1.jpg", () => "IOSPermInstruction1", { virtual: true });
jest.mock("@/app/components/CustomCarousel/CustomCarousel", () => () => null);
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
// The lobby's Exit button (X), pressed through its onPress
jest.mock("@/app/components/CloseButton", () => "CloseButton");
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => () => null);
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

// ── Android back: every screen's hardwareBackPress handlers, the newest first, as BackHandler runs them ──

type BackPressHandler = Parameters<typeof BackHandler.addEventListener>[1];
const backHandlers: BackPressHandler[] = [];
const BACK_PRESS = { type: "hardwareBackPress", timeStamp: 0 };
/** Presses Android back: true if a handler consumed it, false if Android would run its default (leave the app). */
const pressBack = () => {
  let consumed = false;
  act(() => { consumed = [...backHandlers].reverse().some((handler) => handler(BACK_PRESS)); });
  return consumed;
};

let alertSpy: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
    backHandlers.push(handler);
    return { remove: () => { backHandlers.splice(backHandlers.lastIndexOf(handler), 1); } };
  });
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterAll(() => { jest.restoreAllMocks(); });

const HOME = "/";
const LOBBY = "/screens/WaitingRoom";
const GAME = "/screens/GameScreen";
const SETTINGS = "/screens/SettingsInstructionsScreen";
const ROOM = "ABC234";
const LINKED_ROOM = "XYZ789";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };
const SCREENS = { [HOME]: Index, [LOBBY]: WaitingRoom, [GAME]: GameScreen, [SETTINGS]: SettingsInstructionsScreen };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

let app: TestRenderer.ReactTestRenderer | null = null;
const fire = async (socket: FakeSocket, ev: string, ...args: unknown[]) => {
  await act(async () => { socket.fire(ev, ...args); });
  await flush();
};
const pressable = (id: string) => app!.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function");
const press = async (id: string) => {
  await act(async () => { await pressable(id).props.onPress(); });
  await flush();
};
const codeInput = () =>
  app!.root.find((n) => n.props.testID === TEST_IDS.gameCodeInput && typeof n.props.onChangeText === "function");
const showsJoinPanel = () => app!.root.findAll((n) => n.props.testID === TEST_IDS.searchRoomButton).length > 0;
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

/** bob types ROOM in home's join panel and presses Search room: the lobby opens over home. Returns its socket. */
const searchRoom = async () => {
  await press(TEST_IDS.joinGameButton);
  act(() => codeInput().props.onChangeText(ROOM));
  await press(TEST_IDS.searchRoomButton);
  expect(stackPaths()).toEqual([HOME, LOBBY]);
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await fire(socket, "connect");
  return socket;
};

/** In ROOM's lobby, reached from home's Search room. Returns the room's socket. */
const inLobby = async () => {
  const socket = await searchRoom();
  await fire(socket, "room-of-game", roomOfGame);
  return socket;
};

const pressExit = async () => {
  await act(async () => { app!.root.findByType("CloseButton" as any).props.onPress(); });
  await flush();
};

/** Home's logo is laid out again under the lobby (e.g. the keyboard closed): home re-renders on its own. */
const relayoutHome = () =>
  act(() => {
    app!.root.findAllByType("AnimatableView" as any)
      .filter((n) => typeof n.props.onLayout === "function")
      .forEach((n) => n.props.onLayout({ nativeEvent: { layout: { x: 0, y: 123, width: 300, height: 80 } } }));
  });

const noticesShown = () => alertSpy.mock.calls.map(([, message]) => message);

// FlatList schedules cell updates on timers: keep them on fake timers
beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  await AsyncStorage.setItem("hasSeenInitialScreen", "true");
  await AsyncStorage.setItem("username", "bob");
  mockSockets.length = 0;
  backHandlers.length = 0;
  alertSpy.mockClear();
  mockGalleryAccess = GALLERY_OK;
  resetStack();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Back to the home under the lobby and the game (EXP-339)", () => {
  it("Exit from the lobby pops back to that home: no second home is stacked", async () => {
    await startApp();
    const socket = await inLobby();

    await pressExit();

    expect(socket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(stackPaths()).toEqual([HOME]);
    expect(routerCalls.at(-1)).toBe(`dismissTo ${HOME}`);
  });

  it("that home comes back with its form, the typed code kept, and Android back then leaves the app", async () => {
    await startApp();
    await inLobby();
    await pressExit();

    // Not the join panel left open under the lobby (the old second home reopened it)
    expect(showsJoinPanel()).toBe(false);
    expect(pressBack()).toBe(false);
    expect(stackPaths()).toEqual([HOME]);
    await press(TEST_IDS.joinGameButton);
    expect(codeInput().props.value).toBe(ROOM);
  });

  it("Android back in the lobby is its Exit, even after home re-renders underneath with its join panel open", async () => {
    await startApp();
    const socket = await inLobby();
    relayoutHome();

    expect(pressBack()).toBe(true);

    expect(socket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(stackPaths()).toEqual([HOME]);
  });

  it("a refused join pops back to home, which tells why each time, even the same reason twice", async () => {
    await startApp();
    const refused = await searchRoom();
    await fire(refused, "room-of-game", { success: false, message: "Room is full" });

    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([en.serverErrorRoomFull]);

    const refusedAgain = await searchRoom();
    await fire(refusedAgain, "room-of-game", { success: false, message: "Room is full" });

    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([en.serverErrorRoomFull, en.serverErrorRoomFull]);
  });

  it("kicked mid-game: back to the home under the game, which tells why and closes the room's socket", async () => {
    await startApp();
    const socket = await inLobby();
    await fire(socket, "game-started", [player("alice", true), player("bob")]);
    expect(stackPaths()).toEqual([HOME, GAME]);

    await fire(socket, "player-removed", player("bob"));

    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([en.kickedByHost]);
    expect(ctx.socket).toBeNull();
    expect(ctx.gameCode).toBeNull();
  });

  it("the settings instructions' Back pops back to the home that opened them", async () => {
    mockGalleryAccess = GALLERY_DENIED_FOR_GOOD;
    await startApp();
    await press(TEST_IDS.createGameButton);
    await press(TEST_IDS.galleryHelpButton);
    expect(stackPaths()).toEqual([HOME, SETTINGS]);

    await press(TEST_IDS.settingsInstructionsBack);

    expect(stackPaths()).toEqual([HOME]);
    expect(pressBack()).toBe(false);
  });
});

describe("Home's notice comes only from the screens over it (EXP-339)", () => {
  it("a link to home with a message shows nothing, on the mounted home or after leaving a room", async () => {
    await startApp();
    await act(async () => { openDeepLink(HOME, { message: KICKED_BY_HOST_MESSAGE }); });
    await flush();
    expect(noticesShown()).toEqual([]);

    await inLobby();
    await pressExit();
    await act(async () => { openDeepLink(HOME, { message: KICKED_BY_HOST_MESSAGE }); });
    await flush();

    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([]);
  });

  // The kick's notice waits for home's focus, which an invite link in the same navigation batch never lets it have
  it("a kick's notice that home never showed is dropped once another room starts: not shown on leaving that one", async () => {
    await startApp();
    const socket = await inLobby();
    await fire(socket, "game-started", [player("alice", true), player("bob")]);

    await act(async () => {
      socket.fire("player-removed", player("bob"));
      openDeepLink(LOBBY, { code: LINKED_ROOM });
    });
    await flush();
    expect(stackPaths()).toEqual([HOME, LOBBY]);

    await pressInviteJoin(app!);
    await flush();
    const linked = mockSockets.at(-1)!;
    linked.connected = true;
    await fire(linked, "connect");
    await fire(linked, "room-of-game", { ...roomOfGame, room: { ...roomOfGame.room, gameCode: LINKED_ROOM } });
    await pressExit();

    expect(stackPaths()).toEqual([HOME]);
    expect(noticesShown()).toEqual([]);
  });
});
