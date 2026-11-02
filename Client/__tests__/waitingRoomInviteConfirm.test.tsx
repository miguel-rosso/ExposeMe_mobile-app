import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import { TEST_IDS } from "../app/utils/testIds";
import type { FakeSocket } from "../testUtils/fakeSocket";
import {
  inviteJoinEnabled,
  inviteNameInput,
  pressInviteCancel,
  pressInviteJoin,
  showsInviteDialog,
  typeInviteName,
} from "../testUtils/inviteConfirm";

// EXP-347 (DEC-046): an invite link (exposeme://screens/WaitingRoom?code=…, cold or warm) never joins by itself. The
// waiting room asks first: the room code, the saved name filled in and editable, Join and Cancel. Join goes through
// the gallery gate (DEC-015) and joins with the edited name, normalized and saved; Cancel goes home joining nothing.
// Home's Create and Search, "Play again" and a link to the room we are in never ask.

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

const GALLERY_OK = { status: "ok", limited: false, canAskAgain: true };
const GALLERY_DENIED = { status: "denied", limited: false, canAskAgain: true };
let mockGalleryAccess: object = GALLERY_OK;
const mockCheckGalleryAccess = jest.fn(async (_opts: { ask: boolean }) => mockGalleryAccess);
let mockLinkParams: { code?: string } = {};
const mockDismissTo = jest.fn();
const mockReplace = jest.fn();
const mockBackNavigation = jest.fn();
// Route names under the waiting room, bottom first (a link opened mid-game pushes it over the game screen)
let mockRoutesBelow: string[] = ["index"];
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo, back: mockBackNavigation }),
  useLocalSearchParams: () => mockLinkParams,
  ...require("../testUtils/screenNavigation").screenNavigationMock(() => mockRoutesBelow),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: mockCheckGalleryAccess,
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
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => () => null);
// The screen's Android hardware back handler, captured so a test can press "back"
const mockBack: { handler?: () => boolean } = {};
jest.mock("@react-native-community/hooks", () => ({
  useBackHandler: (handler: () => boolean) => { mockBack.handler = handler; },
}));

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const LINKED_ROOM = "XYZ789";
const OTHER_ROOM = "ABC234";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

// One app (GameProvider) per test; the waiting room comes and goes on top of it like a screen.
// Unmounted after each test, so a failing test never leaves a provider running into the next one.
let app: TestRenderer.ReactTestRenderer | null = null;
const startApp = async (storedName: string | null) => {
  if (storedName !== null) await AsyncStorage.setItem("username", storedName);
  await act(async () => { app = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  await flush();
  return app!;
};
/** The waiting room opened with `params` (an invite link's query, or none: Create, Search, "Play again"). */
const openWaitingRoom = async (params: { code?: string }) => {
  mockLinkParams = params;
  await act(async () => { app!.update(<GameProvider><WaitingRoom /><Probe /></GameProvider>); });
  await flush();
  return app!;
};
/** The invite link of LINKED_ROOM, in any case like the shared link. */
const openInviteLink = () => openWaitingRoom({ code: LINKED_ROOM.toLowerCase() });

const connectLatestSocket = async () => {
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await act(async () => { socket.fire("connect"); });
  await flush();
  return socket;
};
const allJoins = () => mockSockets.flatMap((s) => s.emittedPayloads("join-create-game"));
const roomOfGame = (gameCode: string, username: string) => ({
  success: true,
  room: { gameCode, players: [{ username, isHost: true, connected: true }], rounds: 5, started: false },
  rejoinToken: `tok-${gameCode}`,
});
const hasId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const roomCodeShown = (r: TestRenderer.ReactTestRenderer) =>
  r.root.find((n) => n.props.testID === TEST_IDS.inviteRoomCode && typeof n.type === "string").props.children;

// FlatList schedules cell updates on timers: keep them on fake timers
beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockSockets.length = 0;
  mockDismissTo.mockClear();
  mockReplace.mockClear();
  mockBackNavigation.mockClear();
  mockCheckGalleryAccess.mockClear();
  mockGalleryAccess = GALLERY_OK;
  mockLinkParams = {};
  mockRoutesBelow = ["index"];
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Invite link confirmation (EXP-347)", () => {
  it("asks first, with the room code and the saved name filled in, and joins nothing until Join", async () => {
    await startApp("bob");
    const r = await openInviteLink();

    expect(showsInviteDialog(r)).toBe(true);
    expect(roomCodeShown(r)).toBe(LINKED_ROOM);
    expect(inviteNameInput(r).props.value).toBe("bob");
    expect(inviteJoinEnabled(r)).toBe(true);
    expect(mockSockets).toHaveLength(0); // not even connected

    await pressInviteJoin(r);
    expect(showsInviteDialog(r)).toBe(false);
    const socket = await connectLatestSocket();
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("joins with the edited name, normalized, and saves it for the next launch", async () => {
    await startApp("bob");
    const r = await openInviteLink();

    await typeInviteName(r, "  Ana   María ");
    await pressInviteJoin(r);
    const socket = await connectLatestSocket();

    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "Ana María" }]);
    expect(ctx.username).toBe("Ana María");
    expect(await AsyncStorage.getItem("username")).toBe("Ana María");
  });

  it("labels the name field and both buttons for screen readers", async () => {
    await startApp("bob");
    const r = await openInviteLink();
    const byId = (id: string) => r.root.find((n) => n.props.testID === id && typeof n.type !== "string");

    expect(inviteNameInput(r).props.accessibilityLabel).toBe("Your name");
    expect(byId(TEST_IDS.inviteJoinButton).props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Join" });
    expect(byId(TEST_IDS.inviteCancelButton).props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Cancel" });
  });

  it("sits above the lobby's loading overlay", async () => {
    await startApp("bob");
    const r = await openInviteLink();
    const zIndexOf = (id: string) =>
      StyleSheet.flatten(r.root.find((n) => n.props.testID === id && typeof n.type === "string").props.style).zIndex;

    expect(zIndexOf(TEST_IDS.inviteConfirmModal)).toBeGreaterThan(zIndexOf(TEST_IDS.lobbyLoading) as number);
  });

  it("a double tap on Join joins once", async () => {
    await startApp("bob");
    const r = await openInviteLink();
    const join = r.root.find((n) => n.props.testID === TEST_IDS.inviteJoinButton && typeof n.props.onPress === "function");

    await act(async () => { await Promise.all([join.props.onPress(), join.props.onPress()]); });
    const socket = await connectLatestSocket();

    expect(mockSockets).toHaveLength(1);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(1);
  });

  it("Cancel goes home, joining nothing and leaving no socket open", async () => {
    await startApp("bob");
    const r = await openInviteLink();

    await pressInviteCancel(r);
    await flush();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(0);
    expect(ctx.socket).toBeNull();
    expect(ctx.gameCode).toBeNull();
    expect(allJoins()).toEqual([]);
  });

  it("the Android back is Cancel while it asks", async () => {
    await startApp("bob");
    await openInviteLink();

    act(() => { expect(mockBack.handler!()).toBe(true); });
    await flush();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(0);
  });

  it("with no saved name the field is empty and Join stays disabled until a real name is typed", async () => {
    await startApp(null);
    const r = await openInviteLink();

    expect(showsInviteDialog(r)).toBe(true);
    expect(mockDismissTo).not.toHaveBeenCalled(); // no longer sent home to type it there
    expect(inviteNameInput(r).props.value).toBe("");
    expect(inviteJoinEnabled(r)).toBe(false);
    await typeInviteName(r, "   ");
    expect(inviteJoinEnabled(r)).toBe(false);
    await pressInviteJoin(r); // ignored
    expect(mockSockets).toHaveLength(0);

    await typeInviteName(r, "carol");
    expect(inviteJoinEnabled(r)).toBe(true);
    await pressInviteJoin(r);
    const socket = await connectLatestSocket();
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "carol" }]);
  });

  it("the close button (X) while it asks is Cancel: home, no leave, the stored rejoin token kept", async () => {
    // e.g. the token of a game in progress in the linked room, for rejoining it later
    const token = JSON.stringify({ gameCode: LINKED_ROOM, username: "bob", token: "tok-linked" });
    await AsyncStorage.setItem("rejoinToken", token);
    await startApp("bob");
    const r = await openInviteLink();
    const close = r.root.find((n) => n.props.testID === TEST_IDS.closeButton && typeof n.props.onPress === "function");
    expect(close.props.accessibilityLabel).toBe("Cancel");

    await act(async () => { close.props.onPress(); });
    await flush();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockSockets).toHaveLength(0);
    expect(await AsyncStorage.getItem("rejoinToken")).toBe(token);
  });

  it("shows no gallery notice (nor asks for the permission) until Join", async () => {
    await startApp("bob");
    mockGalleryAccess = GALLERY_DENIED;
    const r = await openInviteLink();

    expect(showsInviteDialog(r)).toBe(true);
    expect(hasId(r, TEST_IDS.galleryAccessModal)).toBe(false);
    expect(mockCheckGalleryAccess).not.toHaveBeenCalledWith({ ask: true });
  });

  it("joins nothing when another link replaces the dialog while the gallery answers", async () => {
    await startApp("bob");
    const r = await openInviteLink();
    let answerGallery!: () => void;
    mockCheckGalleryAccess.mockImplementationOnce(
      () => new Promise((resolve) => { answerGallery = () => resolve(GALLERY_OK); })
    );
    let joining!: Promise<void>;
    act(() => {
      joining = r.root.find((n) => n.props.testID === TEST_IDS.inviteJoinButton && typeof n.props.onPress === "function")
        .props.onPress();
    });

    await openWaitingRoom({ code: OTHER_ROOM });
    await act(async () => { answerGallery(); await joining; });
    await flush();

    expect(mockSockets).toHaveLength(0);
    expect(roomCodeShown(r)).toBe(OTHER_ROOM); // still asking, now for the new link's room
  });

  it("checks the gallery access on Join and joins nothing without it (DEC-015)", async () => {
    await startApp("bob");
    mockGalleryAccess = GALLERY_DENIED;
    const r = await openInviteLink();

    await pressInviteJoin(r);
    await flush();
    expect(mockCheckGalleryAccess).toHaveBeenCalledWith({ ask: true });
    expect(hasId(r, TEST_IDS.galleryAccessModal)).toBe(true);
    expect(showsInviteDialog(r)).toBe(true);
    expect(mockSockets).toHaveLength(0);

    // Access granted (e.g. Allow in the notice): Join now joins
    mockGalleryAccess = GALLERY_OK;
    await pressInviteJoin(r);
    const socket = await connectLatestSocket();
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
    expect(hasId(r, TEST_IDS.galleryAccessModal)).toBe(false);
  });

  it("the gallery notice's Back while it asks goes home without joining", async () => {
    await startApp("bob");
    mockGalleryAccess = GALLERY_DENIED;
    const r = await openInviteLink();
    await pressInviteJoin(r);
    await flush();

    await act(async () => {
      r.root.find((n) => n.props.testID === TEST_IDS.galleryBackButton && typeof n.props.onPress === "function").props.onPress();
    });
    await flush();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(0);
  });

  it("a refused join after Join (e.g. the name is taken) goes home with the server's message and the room's code", async () => {
    await startApp("bob");
    const r = await openInviteLink();
    await pressInviteJoin(r);
    const socket = await connectLatestSocket();

    await act(async () => { socket.fire("room-of-game", { success: false, message: "Username already taken" }); });
    await flush();

    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/", params: { message: "Username already taken" } });
    expect(ctx.socket).toBeNull();
    // Home's join panel offers the link's code again, to retry with another name
    expect(ctx.joinCodeDraft).toBe(LINKED_ROOM);
  });

  it("a link to another room from inside a lobby asks, and leaves that room only on Join (EXP-358)", async () => {
    await startApp("bob");
    await openWaitingRoom({ code: OTHER_ROOM });
    await pressInviteJoin(app!);
    const first = await connectLatestSocket();
    await act(async () => { first.fire("room-of-game", roomOfGame(OTHER_ROOM, "bob")); });
    await flush();

    const r = await openInviteLink();
    expect(first.emittedPayloads("leave-room")).toEqual([]);
    expect(showsInviteDialog(r)).toBe(true);
    expect(mockSockets).toHaveLength(1);

    await pressInviteJoin(r);
    expect(first.emittedPayloads("leave-room")).toHaveLength(1);
    const socket = await connectLatestSocket();
    expect(socket).not.toBe(first);
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
  });
});

describe("Joins that never ask (EXP-347)", () => {
  it("home's Create game", async () => {
    await startApp("bob");
    act(() => ctx.requestNewRoom());
    const r = await openWaitingRoom({});

    expect(showsInviteDialog(r)).toBe(false);
    const socket = await connectLatestSocket();
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: null, username: "bob" }]);
  });

  it("home's Search room with a typed code", async () => {
    await startApp("bob");
    act(() => ctx.setGameCode(LINKED_ROOM));
    const r = await openWaitingRoom({});

    expect(showsInviteDialog(r)).toBe(false);
    const socket = await connectLatestSocket();
    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
  });

  it("\"Play again\" after a game, and a socket reconnect in the lobby", async () => {
    await startApp("bob");
    await openInviteLink();
    await pressInviteJoin(app!);
    const socket = await connectLatestSocket();
    await act(async () => { socket.fire("room-of-game", roomOfGame(LINKED_ROOM, "bob")); });
    await flush();

    // The game screen took over (game over keeps the socket), then "Play again" reopens the waiting room
    await act(async () => { app!.update(<GameProvider><Probe /></GameProvider>); });
    const r = await openWaitingRoom({});
    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(2);

    // Back from the background: the socket reconnects and rejoins on its own
    await act(async () => { socket.fire("connect"); });
    await flush();
    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(3);
  });

  it("a link to the room we are in, opened over its game screen: back to it, re-joining nothing (EXP-358)", async () => {
    await startApp("bob");
    await openInviteLink();
    await pressInviteJoin(app!);
    const socket = await connectLatestSocket();
    await act(async () => { socket.fire("room-of-game", roomOfGame(LINKED_ROOM, "bob")); });
    await flush();

    // The game screen took over (it keeps the socket), then the link opens the waiting room over it
    await act(async () => { app!.update(<GameProvider><Probe /></GameProvider>); });
    mockRoutesBelow = ["index", "screens/GameScreen"];
    const joins = socket.emittedPayloads("join-create-game").length;
    const r = await openInviteLink();
    expect(showsInviteDialog(r)).toBe(false);
    expect(mockBackNavigation).toHaveBeenCalledTimes(1);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(joins);
  });
});
