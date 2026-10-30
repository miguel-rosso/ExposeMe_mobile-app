import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import type { FakeSocket } from "../testUtils/fakeSocket";

// EXP-342: a room the player left (Exit, kicked) is forgotten by the real GameProvider. A waiting room opened
// afterwards without a room code (e.g. the link exposeme://screens/WaitingRoom) goes home instead of rejoining it as
// a new player; a link to another room still joins that one; "Play again" (the room not left) still rejoins it.

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

// ── Screen dependencies ──

let mockLinkParams: { code?: string } = {};
const mockDismissTo = jest.fn();
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo }),
  useLocalSearchParams: () => mockLinkParams,
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
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

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const USERNAME = "bob";
const LEFT_ROOM = "ABC234";
const OTHER_ROOM = "XYZ789";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

// One app (GameProvider) for the whole test; the waiting room comes and goes on top of it like a screen.
// Unmounted after each test, so a failing test never leaves a provider running into the next one.
let app: TestRenderer.ReactTestRenderer | null = null;
const startApp = async () => {
  await AsyncStorage.setItem("username", USERNAME);
  await act(async () => { app = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  await flush();
};
/** The waiting room opened with `params` (a link's query, or none for "Play again"). */
const openWaitingRoom = async (params: { code?: string }) => {
  mockLinkParams = params;
  await act(async () => { app!.update(<GameProvider><WaitingRoom /><Probe /></GameProvider>); });
  await flush();
};
/** The waiting room replaced by another screen (home, the game screen). */
const closeWaitingRoom = async () => {
  await act(async () => { app!.update(<GameProvider><Probe /></GameProvider>); });
  await flush();
};

const connectLatestSocket = async () => {
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await act(async () => { socket.fire("connect"); });
  await flush();
  return socket;
};

/** In LEFT_ROOM's lobby: opened by its invite link, joined, and the server answered with the room and a token. */
const joinRoom = async () => {
  await openWaitingRoom({ code: LEFT_ROOM.toLowerCase() });
  const socket = await connectLatestSocket();
  await act(async () => {
    socket.fire("room-of-game", {
      success: true,
      room: { gameCode: LEFT_ROOM, players: [{ username: USERNAME, isHost: true }], rounds: 5, started: false },
      rejoinToken: "tok-left",
    });
  });
  await flush();
  mockDismissTo.mockClear();
  mockReplace.mockClear();
  return socket;
};

const pressExit = async () => {
  await act(async () => { app!.root.findByType("CloseButton" as any).props.onPress(); });
  await flush();
};

const joinsOn = (socket: FakeSocket) => socket.emittedPayloads("join-create-game");

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockSockets.length = 0;
  mockDismissTo.mockClear();
  mockReplace.mockClear();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("A room the player left is forgotten (EXP-342)", () => {
  it("after Exit, a link without a room code goes home and joins nothing", async () => {
    await startApp();
    const left = await joinRoom();
    await pressExit();
    expect(mockReplace).toHaveBeenCalledWith("/");
    expect(ctx.gameCode).toBeNull();
    await closeWaitingRoom();

    const socketsBefore = mockSockets.length;
    await openWaitingRoom({});

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(socketsBefore); // no socket opened, so no join of the left room
    expect(joinsOn(left)).toHaveLength(1); // only the original join
  });

  it("after being kicked, a link without a room code goes home and joins nothing", async () => {
    await startApp();
    const kickedFrom = await joinRoom();
    await act(async () => { kickedFrom.fire("player-removed", { username: USERNAME, isHost: false }); });
    await flush();
    expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/" }));
    expect(ctx.gameCode).toBeNull();
    await closeWaitingRoom();

    const socketsBefore = mockSockets.length;
    await openWaitingRoom({});

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(socketsBefore);
  });

  it("after a refused join of a typed code, home keeps the code and a link without a room code joins nothing", async () => {
    await startApp();
    // Home's Search with a typed code
    act(() => ctx.setJoinCodeDraft(LEFT_ROOM));
    act(() => ctx.setGameCode(LEFT_ROOM));
    await openWaitingRoom({});
    const refused = await connectLatestSocket();
    await act(async () => { refused.fire("room-of-game", { success: false, message: "Username already taken" }); });
    await flush();
    expect(mockReplace).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/" }));
    expect(ctx.gameCode).toBeNull();
    expect(ctx.joinCodeDraft).toBe(LEFT_ROOM); // home's join panel shows it again
    await closeWaitingRoom();

    const socketsBefore = mockSockets.length;
    await openWaitingRoom({});

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(socketsBefore);
    expect(joinsOn(refused)).toHaveLength(1);
  });

  it("after Exit, a link to another room joins that room on a new socket, without the left room's token", async () => {
    await startApp();
    await joinRoom();
    await pressExit();
    await closeWaitingRoom();

    await openWaitingRoom({ code: OTHER_ROOM.toLowerCase() });
    const socket = await connectLatestSocket();

    expect(joinsOn(socket)).toEqual([{ gameCode: OTHER_ROOM, username: USERNAME }]);
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("an invite link to another room from inside the lobby leaves this one and joins the linked one", async () => {
    await startApp();
    const left = await joinRoom();

    await openWaitingRoom({ code: OTHER_ROOM.toLowerCase() });
    expect(left.emitted.some(([ev]) => ev === "leave-room")).toBe(true);
    const socket = await connectLatestSocket();

    expect(socket).not.toBe(left);
    expect(joinsOn(socket)).toEqual([{ gameCode: OTHER_ROOM, username: USERNAME }]);
    expect(ctx.gameCode).toBe(OTHER_ROOM);
  });

  it("\"Play again\" (the room not left) reopens the waiting room without a code and rejoins it on the same socket", async () => {
    await startApp();
    const socket = await joinRoom();
    await closeWaitingRoom(); // the game screen took over; game over keeps the socket open

    await openWaitingRoom({});

    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(mockSockets).toHaveLength(1);
    expect(joinsOn(socket).at(-1)).toEqual({ gameCode: LEFT_ROOM, username: USERNAME, rejoinToken: "tok-left" });
  });
});
