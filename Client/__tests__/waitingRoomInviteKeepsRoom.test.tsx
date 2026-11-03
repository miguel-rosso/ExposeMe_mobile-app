import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import { TEST_IDS } from "../app/utils/testIds";
import type { FakeSocket } from "../testUtils/fakeSocket";
import { pressInviteCancel, pressInviteJoin, showsInviteDialog } from "../testUtils/inviteConfirm";

// EXP-358 (DEC-047, option A): a player in a lobby who opens an invite link to another room stays in their room while
// the invite dialog asks: same socket, still bound (no leave-room), still host, the lobby as it was. They leave it only
// on Join, which then joins the linked room. Cancel (or the X, or back) returns them to their room unchanged. If the
// room takes the screen away while Join waits for the gallery check, that Join does nothing. The same over a running
// game, with the real game screen under it: waitingRoomInviteOverGame.test.tsx.

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
const mockRouter = { replace: jest.fn(), dismissTo: jest.fn(), back: jest.fn(), setParams: jest.fn(), push: jest.fn() };
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockLinkParams,
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
const GALLERY_OK = { status: "ok", limited: false, canAskAgain: true };
const mockCheckGalleryAccess = jest.fn(async (_opts: { ask: boolean }) => GALLERY_OK);
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

const MY_ROOM = "ABC234";
const LINKED_ROOM = "XYZ789";
const MY_TOKEN = `tok-${MY_ROOM}`;

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

// One app (GameProvider) per test; screens come and go on top of it. Unmounted after each test.
let app: TestRenderer.ReactTestRenderer | null = null;
const render = async (screens: React.ReactNode) => {
  await act(async () => { app!.update(<GameProvider>{screens}<Probe /></GameProvider>); });
  await flush();
  return app!;
};
const startApp = async () => {
  await AsyncStorage.setItem("username", "bob");
  await act(async () => { app = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  await flush();
};

const connectLatestSocket = async () => {
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await act(async () => { socket.fire("connect"); });
  await flush();
  return socket;
};
const roomOfGame = (gameCode: string, usernames: string[]) => ({
  success: true,
  room: {
    gameCode,
    players: usernames.map((username, i) => ({ username, isHost: i === 0, connected: true })),
    rounds: 5,
    started: false,
  },
  rejoinToken: `tok-${gameCode}`,
});
const hasId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const storedToken = async () => JSON.parse((await AsyncStorage.getItem("rejoinToken")) ?? "null");

/** bob, host of MY_ROOM with alice, in its lobby (opened from home's Search room). Returns the room's socket. */
const hostInMyLobby = async () => {
  await startApp();
  act(() => ctx.setGameCode(MY_ROOM));
  mockLinkParams = {};
  await render(<WaitingRoom />);
  const socket = await connectLatestSocket();
  await act(async () => { socket.fire("room-of-game", roomOfGame(MY_ROOM, ["bob", "alice"])); });
  await flush();
  return socket;
};

/** An invite link reaching the lobby that is open (the same screen, its link parameter changes). */
const linkReachesLobby = (code: string = LINKED_ROOM) => {
  mockLinkParams = { code };
  return render(<WaitingRoom />);
};

/** The lobby's link parameter cleared (what Cancel asks the router for). */
const clearLobbyLink = () => {
  mockLinkParams = {};
  return render(<WaitingRoom />);
};

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockSockets.length = 0;
  Object.values(mockRouter).forEach((fn) => fn.mockClear());
  mockCheckGalleryAccess.mockClear();
  mockLinkParams = {};
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Invite link to another room from a lobby (EXP-358)", () => {
  it("keeps the room while the dialog asks: no leave, same socket, still host, the lobby as it was", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();

    expect(showsInviteDialog(r)).toBe(true);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.socket).toBe(socket);
    expect(ctx.gameCode).toBe(MY_ROOM);
    expect(mockSockets).toHaveLength(1);
    expect(hasId(r, "lobby-player-alice")).toBe(true);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    // Still listening to the room behind the dialog
    await act(async () => { socket.fire("player-joined", { username: "carol", isHost: false, connected: true }); });
    expect(hasId(r, "lobby-player-carol")).toBe(true);
  });

  it("Cancel returns to the lobby unchanged: no leave, still host, token kept, no navigation", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();

    await pressInviteCancel(r);
    await flush();

    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(ctx.socket).toBe(socket);
    expect(ctx.gameCode).toBe(MY_ROOM);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    expect(hasId(r, TEST_IDS.lobbyLoading)).toBe(false);
    expect(await storedToken()).toEqual({ gameCode: MY_ROOM, username: "bob", token: MY_TOKEN });
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
    // The lobby keeps working: starting the game still goes out on the room's socket
    await act(async () => {
      r.root.find((n) => n.props.testID === TEST_IDS.startGameButton && typeof n.props.onPress === "function").props.onPress();
    });
    expect(socket.emittedPayloads("start-game")).toEqual([expect.any(Function)]); // only its ack (EXP-379)
  });

  it("the X and the Android back while it asks are Cancel too", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    await act(async () => {
      r.root.find((n) => n.props.testID === TEST_IDS.closeButton && typeof n.props.onPress === "function").props.onPress();
    });
    await flush();
    expect(showsInviteDialog(r)).toBe(false);

    await clearLobbyLink(); // what Cancel asked the router for
    await linkReachesLobby();
    expect(showsInviteDialog(r)).toBe(true);
    act(() => { expect(mockBack.handler!()).toBe(true); });
    await flush();

    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.socket).toBe(socket);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("Cancel clears the link, so the same link asks again; the cleared link changes nothing", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    await pressInviteCancel(r);
    expect(mockRouter.setParams).toHaveBeenCalledWith({ code: undefined });

    await clearLobbyLink();
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(1);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockSockets).toHaveLength(1);

    await linkReachesLobby();
    expect(showsInviteDialog(r)).toBe(true);
  });

  it("Join leaves the room, then joins the linked one on a new socket", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();

    await pressInviteJoin(r);
    expect(socket.emittedPayloads("leave-room")).toHaveLength(1);
    expect(ctx.socket).not.toBe(socket);
    expect(hasId(r, "lobby-player-alice")).toBe(false);

    const linked = await connectLatestSocket();
    expect(linked).not.toBe(socket);
    expect(linked.emittedPayloads("join-create-game")).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
    expect(socket.emittedPayloads("join-create-game")).toHaveLength(1); // nothing more on the old room's socket
  });

  it("a link to the room this lobby is in, while it asks for another room, closes the dialog and stays", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    expect(showsInviteDialog(r)).toBe(true);

    await linkReachesLobby(MY_ROOM);

    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.socket).toBe(socket);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    expect(mockSockets).toHaveLength(1);
  });

  it("a link to the room this lobby is in asks nothing and leaves nothing", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby(MY_ROOM);

    expect(showsInviteDialog(r)).toBe(false);
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(ctx.socket).toBe(socket);
  });
});

describe("The room takes the lobby away while Join waits for the gallery check (EXP-358)", () => {
  /** Taps Join with the gallery check held; returns the function that answers it (ok) and lets Join finish. */
  const pressJoinHoldingGallery = (r: TestRenderer.ReactTestRenderer) => {
    let answerGallery!: () => void;
    mockCheckGalleryAccess.mockImplementationOnce(
      () => new Promise((resolve) => { answerGallery = () => resolve(GALLERY_OK); })
    );
    let joining!: Promise<void>;
    act(() => {
      joining = r.root.find((n) => n.props.testID === TEST_IDS.inviteJoinButton && typeof n.props.onPress === "function")
        .props.onPress();
    });
    return () => act(async () => { answerGallery(); await joining; });
  };

  const expectJoinDidNothing = (socket: FakeSocket) => {
    expect(socket.emittedPayloads("leave-room")).toEqual([]);
    expect(mockSockets).toHaveLength(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
  };

  it("the host starts the game: no leave and no socket for the linked room", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    const finishJoin = pressJoinHoldingGallery(r);

    await act(async () => { socket.fire("game-started", [{ username: "alice" }, { username: "bob" }]); });
    await finishJoin();
    await flush();

    expect(mockRouter.replace).toHaveBeenCalledWith("/screens/GameScreen");
    expectJoinDidNothing(socket);
    expect(ctx.gameCode).toBe(MY_ROOM);
  });

  it("the host removes me: no leave and no socket left open at home", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    const finishJoin = pressJoinHoldingGallery(r);

    await act(async () => { socket.fire("player-removed", { username: "bob" }); });
    await finishJoin();
    await flush();

    expect(mockRouter.dismissTo).toHaveBeenCalledWith("/");
    expectJoinDidNothing(socket);
    expect(ctx.socket).toBeNull();
  });

  it("the lobby unmounts: nothing joins from it", async () => {
    const socket = await hostInMyLobby();
    const r = await linkReachesLobby();
    const finishJoin = pressJoinHoldingGallery(r);

    await render(null);
    await finishJoin();
    await flush();

    expectJoinDidNothing(socket);
  });
});
