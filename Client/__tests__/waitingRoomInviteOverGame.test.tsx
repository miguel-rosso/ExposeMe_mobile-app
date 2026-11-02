import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import GameScreen from "../app/screens/GameScreen";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import type { FakeSocket } from "../testUtils/fakeSocket";
import { openDeepLink, resetStack, routerCalls, StackScreens, stackPaths, stackRouter } from "../testUtils/stackRouter";
import { pressInviteCancel, pressInviteJoin, showsInviteDialog } from "../testUtils/inviteConfirm";
import { TEST_IDS } from "../app/utils/testIds";

// EXP-358 / EXP-360 / EXP-359: an invite link opened during a game pushes the waiting room over the game screen, which
// stays mounted underneath (a native stack). While the invite dialog asks, the game is the player's: Cancel goes back
// to it, and a navigation the game screen starts (the next game, out of the room) closes the dialog first instead of
// replacing it. Join leaves the game's room and takes the game screen off the stack, so it never drives the linked
// room's socket (re-joins, im-ready, your-turn photo uploads). A link to the game's own room just goes back to it.

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

const GALLERY_OK = { status: "ok", limited: false, canAskAgain: true };
const mockCheckGalleryAccess = jest.fn(async (_opts: { ask: boolean }) => GALLERY_OK);
const mockPickGamePhoto = jest.fn();
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: mockCheckGalleryAccess,
    selectMorePhotos: jest.fn(async () => {}),
    pickGamePhoto: (...a: unknown[]) => mockPickGamePhoto(...a),
    setPhotoUri: jest.fn(),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
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
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
});
afterAll(() => { jest.restoreAllMocks(); });

const LOBBY = "/screens/WaitingRoom";
const GAME = "/screens/GameScreen";
const HOME = "/";
const MY_ROOM = "ABC234";
const LINKED_ROOM = "XYZ789";
// Events only the game screen listens to
const GAME_EVENTS = ["round-start", "your-turn", "waiting-photo"];

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };
const SCREENS = { [HOME]: () => null, [LOBBY]: WaitingRoom, [GAME]: GameScreen };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

let app: TestRenderer.ReactTestRenderer | null = null;
const fire = async (socket: FakeSocket, ev: string, ...args: unknown[]) => {
  await act(async () => { socket.fire(ev, ...args); });
  await flush();
};
const connectLatestSocket = async () => {
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await fire(socket, "connect");
  return socket;
};
const player = (username: string, isHost = false) => ({ username, points: 0, isHost, connected: true });
const roomOfGame = (gameCode: string) => ({
  success: true,
  room: { gameCode, players: [player("alice", true), player("bob")], rounds: 5, started: false },
  rejoinToken: `tok-${gameCode}`,
});
const gameListeners = (socket: FakeSocket) => GAME_EVENTS.reduce((n, ev) => n + socket.listenerCount(ev), 0);

/** bob, in MY_ROOM's game: Search room from home, the lobby, then the host's start. Returns the room's socket. */
const inMyGame = async () => {
  await AsyncStorage.setItem("username", "bob");
  await act(async () => { app = TestRenderer.create(<GameProvider><StackScreens screens={SCREENS} /><Probe /></GameProvider>); });
  await flush();
  act(() => ctx.setGameCode(MY_ROOM));
  await act(async () => { stackRouter.push(LOBBY); });
  await flush();
  const socket = await connectLatestSocket();
  await fire(socket, "room-of-game", roomOfGame(MY_ROOM));
  await fire(socket, "game-started", [player("alice", true), player("bob")]);
  expect(stackPaths()).toEqual([HOME, GAME]);
  expect(gameListeners(socket)).toBeGreaterThan(0);
  return socket;
};

/** The invite link of `code` (none: no code param) opened during the game: the waiting room is pushed over the game screen. */
const openLink = async (code?: string) => {
  await act(async () => { openDeepLink(LOBBY, code === undefined ? {} : { code }); });
  await flush();
  return app!;
};

const holdGalleryCheck = () => {
  let answer!: () => void;
  mockCheckGalleryAccess.mockImplementationOnce(
    () => new Promise((resolve) => { answer = () => resolve(GALLERY_OK); })
  );
  return () => act(async () => { answer(); });
};
const pressJoinWithoutWaiting = (r: TestRenderer.ReactTestRenderer) => {
  let joining!: Promise<void>;
  act(() => {
    joining = r.root.find((n) => n.props.testID === TEST_IDS.inviteJoinButton && typeof n.props.onPress === "function")
      .props.onPress();
  });
  return () => act(async () => { await joining; });
};

// FlatList schedules cell updates on timers: keep them on fake timers
beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockSockets.length = 0;
  mockCheckGalleryAccess.mockClear();
  mockPickGamePhoto.mockReset();
  resetStack();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Invite link over a running game (EXP-358)", () => {
  it("asks over the game, which keeps its socket and its listeners", async () => {
    const socket = await inMyGame();
    const listeners = gameListeners(socket);
    const joins = socket.emittedPayloads("join-create-game").length;
    const r = await openLink(LINKED_ROOM);

    expect(stackPaths()).toEqual([HOME, GAME, LOBBY]);
    expect(showsInviteDialog(r)).toBe(true);
    expect(gameListeners(socket)).toBe(listeners);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(joins);
  });

  it("Cancel goes back to the game, still in the room", async () => {
    const socket = await inMyGame();
    const listeners = gameListeners(socket);
    const r = await openLink(LINKED_ROOM);

    await pressInviteCancel(r);
    await flush();

    expect(stackPaths()).toEqual([HOME, GAME]);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.socket).toBe(socket);
    expect(ctx.gameCode).toBe(MY_ROOM);
    expect(gameListeners(socket)).toBe(listeners);
  });

  it("Join leaves the game's room and takes the game screen off the stack before the linked room's socket", async () => {
    const socket = await inMyGame();
    const r = await openLink(LINKED_ROOM);

    await pressInviteJoin(r);
    await flush();
    expect(socket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(stackPaths()).not.toContain(GAME);

    const linked = await connectLatestSocket();
    expect(mockSockets).toHaveLength(2);
    expect(linked.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
    // The old game screen drives nothing on the linked room's socket (EXP-359: no your-turn photo upload)
    expect(gameListeners(linked)).toBe(0);
    await fire(linked, "your-turn", { round: 1, duration: 15_000 });
    expect(mockPickGamePhoto).not.toHaveBeenCalled();
    expect(linked.emittedPayloads("im-ready")).toEqual([]);
    expect(linked.emittedPayloads("join-create-game")).toHaveLength(1);
  });

  it("a link to the game's own room goes back to the game, re-joining nothing", async () => {
    const socket = await inMyGame();
    const joins = socket.emittedPayloads("join-create-game").length;
    const r = await openLink(MY_ROOM);

    expect(showsInviteDialog(r)).toBe(false);
    expect(stackPaths()).toEqual([HOME, GAME]);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(joins);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
  });

  // EXP-363: not "Play again" (which replaces the game screen): re-joining here left two game screens listening
  it.each([
    ["a malformed code", "12345O"],
    ["an empty code", ""],
    ["no code param at all", undefined],
  ])("a link with %s goes back to the game, re-joining nothing", async (_name, code) => {
    const socket = await inMyGame();
    const listeners = gameListeners(socket);
    const joins = socket.emittedPayloads("join-create-game").length;
    const r = await openLink(code);

    expect(showsInviteDialog(r)).toBe(false);
    expect(stackPaths()).toEqual([HOME, GAME]);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(joins);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(gameListeners(socket)).toBe(listeners);
  });

  // The same waiting room without a code, in place of the game screen (as Play again opens it), rejoins the room
  it("Play again (replacing the game screen) still rejoins the room on its socket", async () => {
    const socket = await inMyGame();
    await fire(socket, "game-over", { finalScore: [] });
    const joins = socket.emittedPayloads("join-create-game").length;

    await act(async () => { stackRouter.replace(LOBBY); });
    await flush();

    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(joins + 1);
    expect(socket.emittedPayloads("join-create-game").at(-1)).toMatchObject({ gameCode: MY_ROOM, username: "bob" });
    expect(gameListeners(socket)).toBe(0);
  });
});

describe("The game screen navigates while the invite dialog asks over it (EXP-360)", () => {
  // Current behaviour: the dialog closes without a notice. Whether the player should be told is a pending decision
  // (EXP-360); this test pins the stack, not that design.
  it("the next game currently closes the dialog silently: one lobby on top of home, no game screen left", async () => {
    const socket = await inMyGame();
    await fire(socket, "game-over", { finalScore: [] });
    const r = await openLink(LINKED_ROOM);
    expect(showsInviteDialog(r)).toBe(true);

    await fire(socket, "game-started", [player("alice", true), player("bob")]);

    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(socket.emittedPayloads("join-create-game").at(-1)).toMatchObject({ gameCode: MY_ROOM, username: "bob" });
  });

  it("out of the room (kicked) closes the dialog and goes home", async () => {
    const socket = await inMyGame();
    const r = await openLink(LINKED_ROOM);

    await fire(socket, "player-removed", player("bob"));

    // The home under the game, not a second one over it (EXP-339)
    expect(stackPaths()).toEqual([HOME]);
    expect(showsInviteDialog(r)).toBe(false);
    expect(routerCalls.at(-1)).toBe(`dismissTo ${HOME}`);
  });

  // expo-router queues the link's push and the game screen's navigation together: the game screen still believes it
  // is the top screen (its blur effect has not run) when it navigates
  it("the next game in the same tick as the link: one lobby, no game screen nor its listeners left", async () => {
    const socket = await inMyGame();
    await fire(socket, "game-over", { finalScore: [] });

    await act(async () => {
      openDeepLink(LOBBY, { code: LINKED_ROOM });
      socket.fire("game-started", [player("alice", true), player("bob")]);
    });
    await flush();

    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(gameListeners(socket)).toBe(0);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
  });

  it("a kick in the same tick as the link: home, no game screen nor its listeners left", async () => {
    const socket = await inMyGame();

    await act(async () => {
      openDeepLink(LOBBY, { code: LINKED_ROOM });
      socket.fire("player-removed", player("bob"));
    });
    await flush();

    expect(stackPaths()).toEqual([HOME]);
    expect(gameListeners(socket)).toBe(0);
  });

  it("the next game while Join waits for the gallery: the dialog's screen is gone and leaves nothing", async () => {
    const socket = await inMyGame();
    await fire(socket, "game-over", { finalScore: [] });
    const r = await openLink(LINKED_ROOM);
    const answerGallery = holdGalleryCheck();
    const settleJoin = pressJoinWithoutWaiting(r);

    await fire(socket, "game-started", [player("alice", true), player("bob")]);
    await answerGallery();
    await settleJoin();
    await flush();

    expect(stackPaths()).toEqual([HOME, LOBBY]);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(mockSockets).toHaveLength(1);
    expect(ctx.gameCode).toBe(MY_ROOM);
  });
});
