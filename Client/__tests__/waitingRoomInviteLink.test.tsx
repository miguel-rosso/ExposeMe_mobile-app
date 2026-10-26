import React from "react";
import TestRenderer, { act } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-206: an invite link to another room must win over the room code left from a previous game: leave the old
// room (GameContext's leave: leave-room, forget its rejoin token, drop the socket) and join the linked one. A link to the room we are
// already in, and no link at all, behave as before.

// ── Fake socket ──────────────────────────────────────────

type Handler = (...args: any[]) => void;
class MockSocket {
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  constructor(public name: string, public connected: boolean) {}
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string) {
    this.handlers.delete(ev);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    mockLog.push(`${this.name}:${ev}`);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
}

// ── Game context: a tiny store standing in for GameProvider (socket lifecycle, code, rejoin token) ──

interface MockState {
  socket: MockSocket | null;
  gameCode: string | null;
  token: { gameCode: string; token: string } | null;
}
const mockLog: string[] = [];
const mockStore = {
  state: { socket: null, gameCode: null, token: null } as MockState,
  listeners: new Set<() => void>(),
  set(patch: Partial<MockState>) {
    mockStore.state = { ...mockStore.state, ...patch };
    mockStore.listeners.forEach((l) => l());
  },
};
let mockDeepLinkCode: string | undefined;
const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => (mockDeepLinkCode === undefined ? {} : { code: mockDeepLinkCode }),
}));
jest.mock("../app/providers/GameContext", () => {
  const { useSyncExternalStore } = require("react");
  const subscribe = (l: () => void) => {
    mockStore.listeners.add(l);
    return () => mockStore.listeners.delete(l);
  };
  const startSocket = () => {
    if (mockStore.state.socket?.connected) return;
    mockLog.push("startSocket");
    mockStore.set({ socket: new MockSocket("new", false) });
  };
  const endSocket = () => {
    mockLog.push("endSocket");
    mockStore.state.socket?.removeAllListeners().disconnect();
    mockStore.set({ socket: null });
  };
  // Like GameProvider: the old socket is dropped at once (it closes later, once the server acks the leave)
  const leaveRoom = () => {
    mockStore.state.socket?.removeAllListeners().emit("leave-room");
    mockLog.push("leaveRoom");
    mockStore.set({ socket: null, token: null });
  };
  return {
    useGameContext: () => {
      const state: MockState = useSyncExternalStore(subscribe, () => mockStore.state);
      return {
        socket: state.socket, gameCode: state.gameCode, username: "bob", roundsOfGame: 10,
        startSocket, endSocket, leaveRoom,
        setGameCode: (gameCode: string | null) => mockStore.set({ gameCode }),
        setPlayersProvider: jest.fn(), setRoundsOfGame: jest.fn(), setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(),
        saveRejoinToken: (gameCode: string, _name: string, token: string) => mockStore.set({ token: { gameCode, token } }),
        getRejoinToken: async (code: string) => (mockStore.state.token?.gameCode === code ? mockStore.state.token.token : null),
        clearRejoinToken: () => {
          mockLog.push("clearRejoinToken");
          mockStore.set({ token: null });
        },
      };
    },
  };
});
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
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const OLD_ROOM = "ABC234";
const LINKED_ROOM = "XYZ789";
const OLD_TOKEN = { gameCode: OLD_ROOM, token: "tok-old" };

const flush = () => act(async () => { await Promise.resolve(); });

// Unmounted after each test, so a failing test never leaves a lobby subscribed to the next test's store
let mounted: TestRenderer.ReactTestRenderer | null = null;
const mount = async () => {
  await act(async () => { mounted = TestRenderer.create(<WaitingRoom />); });
  await flush();
  return mounted!;
};

const joins = (socket: MockSocket | null) =>
  (socket?.emitted ?? []).filter(([ev]) => ev === "join-create-game").map(([, data]) => data);

/** The socket kept open from the previous game (game over keeps it; it is still bound to the old room). */
const afterPreviousGame = () => {
  const oldSocket = new MockSocket("old", true);
  mockStore.set({ socket: oldSocket, gameCode: OLD_ROOM, token: OLD_TOKEN });
  return oldSocket;
};

const connectNewSocket = async () => {
  const socket = mockStore.state.socket!;
  socket.connected = true;
  await act(async () => { socket.fire("connect"); });
  return socket;
};

const roomOfGame = (gameCode: string, usernames: string[]) => ({
  success: true,
  room: { gameCode, players: usernames.map((username, i) => ({ username, isHost: i === 0, connected: true })), rounds: 10 },
  rejoinToken: `tok-${gameCode}`,
});

const chatShown = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "ChatMessage").map((n) => n.props.message);
const hasTestId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id).length > 0;

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});
beforeEach(() => {
  jest.useFakeTimers();
  mockStore.state = { socket: null, gameCode: null, token: null };
  mockLog.length = 0;
  mockDeepLinkCode = undefined;
  mockReplace.mockClear();
});

describe("WaitingRoom: invite link after a previous game (EXP-206)", () => {
  it("leaves the old room, forgets its token and joins the linked room on a new socket", async () => {
    const oldSocket = afterPreviousGame();
    mockDeepLinkCode = LINKED_ROOM.toLowerCase(); // any case, like the shared link
    await mount();

    expect(mockLog).toEqual(["old:leave-room", "leaveRoom", "startSocket"]);
    expect(joins(oldSocket)).toEqual([]);
    expect(mockStore.state.gameCode).toBe(LINKED_ROOM);
    expect(mockStore.state.token).toBeNull();

    const newSocket = await connectNewSocket();
    expect(joins(newSocket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
  });

  it("re-joins the same room on the same socket when the link points to the room we are in", async () => {
    const socket = afterPreviousGame();
    mockDeepLinkCode = OLD_ROOM;
    await mount();

    expect(mockLog).toEqual(["old:join-create-game"]);
    expect(joins(socket)).toEqual([{ gameCode: OLD_ROOM, username: "bob", rejoinToken: "tok-old" }]);
    expect(mockStore.state.token).toEqual(OLD_TOKEN);
  });

  it("without a link keeps rejoining the room it knows (Play again, auto-join)", async () => {
    const socket = afterPreviousGame();
    await mount();

    expect(mockLog).toEqual(["old:join-create-game"]);
    expect(joins(socket)).toEqual([{ gameCode: OLD_ROOM, username: "bob", rejoinToken: "tok-old" }]);
  });

  it("ignores a malformed link and keeps the known room", async () => {
    const socket = afterPreviousGame();
    mockDeepLinkCode = "nope";
    await mount();

    expect(mockLog).toEqual(["old:join-create-game"]);
    expect(joins(socket)).toEqual([{ gameCode: OLD_ROOM, username: "bob", rejoinToken: "tok-old" }]);
  });

  it("on a cold start joins the linked room and keeps a stored token for it", async () => {
    mockStore.set({ token: { gameCode: LINKED_ROOM, token: "tok-linked" } });
    mockDeepLinkCode = LINKED_ROOM;
    await mount();

    expect(mockLog).toEqual(["startSocket"]);
    const socket = await connectNewSocket();
    expect(joins(socket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob", rejoinToken: "tok-linked" }]);
  });

  it("keeps a stored token for the linked room when the known code binds no socket (typed on Home)", async () => {
    mockStore.set({ gameCode: OLD_ROOM, token: { gameCode: LINKED_ROOM, token: "tok-linked" } });
    mockDeepLinkCode = LINKED_ROOM;
    await mount();

    expect(mockLog).toEqual(["startSocket"]);
    const socket = await connectNewSocket();
    expect(joins(socket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob", rejoinToken: "tok-linked" }]);
  });

  it("switches rooms when a new link reaches the lobby that is already open, showing nothing from the old room", async () => {
    const oldSocket = afterPreviousGame();
    const r = await mount();
    expect(joins(oldSocket)).toHaveLength(1);
    act(() => oldSocket.fire("room-of-game", roomOfGame(OLD_ROOM, ["alice", "bob"])));
    act(() => oldSocket.fire("chat-message", { username: "alice", message: "hi from A" }));
    expect(chatShown(r)).toEqual(["hi from A"]);
    expect(hasTestId(r, "lobby-player-alice")).toBe(true);
    mockLog.length = 0;

    mockDeepLinkCode = LINKED_ROOM;
    await act(async () => { r.update(<WaitingRoom />); });
    await flush();

    expect(mockLog).toEqual(["old:leave-room", "leaveRoom", "startSocket"]);
    expect(chatShown(r)).toEqual([]);
    expect(hasTestId(r, "lobby-player-alice")).toBe(false);

    const newSocket = await connectNewSocket();
    expect(joins(newSocket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
    act(() => newSocket.fire("room-of-game", roomOfGame(LINKED_ROOM, ["carol", "bob"])));
    expect(hasTestId(r, "lobby-player-carol")).toBe(true);
    expect(hasTestId(r, "lobby-player-alice")).toBe(false);
    expect(chatShown(r)).toEqual([]);
  });
});
