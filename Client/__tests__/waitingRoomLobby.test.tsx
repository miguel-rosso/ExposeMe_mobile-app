import React from "react";
import TestRenderer, { act } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { TEST_IDS, lobbyPlayerId, roundsOptionId } from "../app/utils/testIds";

// EXP-063: the lobby's socket flow. Joining (with the stored rejoin token), the player list following
// player-joined / player-left / player-removed, the host's start controls (only with 2+ players), rounds, entering
// the game on game-started, and every way out (refused join, kicked, leaving) ending the socket.

// ── Fake socket ──────────────────────────────────────────

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn?: Handler) {
    if (fn) this.handlers.get(ev)?.delete(fn);
    else this.handlers.delete(ev);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
}

const mockSocket = new FakeSocket();
const mockReplace = jest.fn();
const mockCtx = {
  startSocket: jest.fn(), endSocket: jest.fn(), setGameCode: jest.fn(), setPlayersProvider: jest.fn(),
  setRoundsOfGame: jest.fn(), setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
  getRejoinToken: jest.fn(async (..._a: unknown[]) => "tok-123" as string | null), clearRejoinToken: jest.fn(),
};
const mockClose: { onPress?: () => void } = {};
/** Context game code and route params (invite deep link), per test */
const mockRoute: { gameCode: string | null; params: { code?: string | string[] } } = { gameCode: "K7MQ4X", params: {} };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockRoute.params,
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    ...mockCtx, gameCode: mockRoute.gameCode, socket: mockSocket, username: "alice", roundsOfGame: 10, plantedPhotoUri: null,
  }),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
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
jest.mock("@/app/components/CloseButton", () => (p: { onPress: () => void }) => { mockClose.onPress = p.onPress; return null; });
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

// Players exactly as the server sends them (public allowlist: no socketId)
const player = (username: string, isHost = false) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
  mockSocket.connected = true;
  mockReplace.mockClear();
  Object.values(mockCtx).forEach((f) => f.mockClear());
  mockRoute.gameCode = "K7MQ4X";
  mockRoute.params = {};
});

const roomOfGame = (players: ReturnType<typeof player>[], extra: object = {}) =>
  ({ success: true, room: { gameCode: "K7MQ4X", players, rounds: 10, started: false }, rejoinToken: "tok-123", ...extra });

async function mount(players?: ReturnType<typeof player>[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  if (players) act(() => mockSocket.fire("room-of-game", roomOfGame(players)));
  return r;
}
const hasId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const pressId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  act(() => { r.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress(); });
const emitted = (ev: string) => mockSocket.emitted.filter(([e]) => e === ev).map(([, d]) => d);

describe("WaitingRoom: joining (EXP-063)", () => {
  it("starts the socket and joins with the stored rejoin token, then saves the room's token and rounds", async () => {
    const r = await mount();
    expect(mockCtx.startSocket).toHaveBeenCalledTimes(1);
    expect(mockCtx.getRejoinToken).toHaveBeenCalledWith("K7MQ4X", "alice");
    expect(emitted("join-create-game")).toEqual([{ gameCode: "K7MQ4X", username: "alice", rejoinToken: "tok-123" }]);

    act(() => mockSocket.fire("room-of-game", { ...roomOfGame([player("alice", true)]), room: { gameCode: "K7MQ4X", players: [player("alice", true)], rounds: 15, started: false } }));
    expect(mockCtx.saveRejoinToken).toHaveBeenCalledWith("K7MQ4X", "alice", "tok-123");
    expect(mockCtx.setGameCode).toHaveBeenCalledWith("K7MQ4X");
    expect(mockCtx.setRoundsOfGame).toHaveBeenCalledWith(15);
    expect(hasId(r, lobbyPlayerId("alice"))).toBe(true);
    act(() => r.unmount());
  });

  it("joins without a token field when none is stored for this room", async () => {
    mockCtx.getRejoinToken.mockResolvedValueOnce(null);
    const r = await mount();
    expect(emitted("join-create-game")).toEqual([{ gameCode: "K7MQ4X", username: "alice" }]);
    act(() => r.unmount());
  });

  it("joins again on every (re)connect of the socket", async () => {
    mockSocket.connected = false;
    const r = await mount();
    expect(emitted("join-create-game")).toHaveLength(0); // not connected yet
    await act(async () => { mockSocket.fire("connect"); await Promise.resolve(); });
    expect(emitted("join-create-game")).toHaveLength(1);
    await act(async () => { mockSocket.fire("connect"); await Promise.resolve(); });
    expect(emitted("join-create-game")).toHaveLength(2);
    act(() => r.unmount());
  });

  it("a refused join ends the socket and goes home with the server's message", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", { success: false, message: "Room is full" }));
    expect(mockCtx.endSocket).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/", params: { message: "Room is full" } });
    act(() => r.unmount());
  });
});

describe("WaitingRoom: player list and host controls (EXP-063)", () => {
  it("player-joined / player-left keep the list in sync, and the start controls need 2 players", async () => {
    const r = await mount([player("alice", true)]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);

    act(() => mockSocket.fire("player-joined", player("bob")));
    expect(hasId(r, lobbyPlayerId("bob"))).toBe(true);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(false);

    act(() => mockSocket.fire("player-left", "bob"));
    expect(hasId(r, lobbyPlayerId("bob"))).toBe(false);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => r.unmount());
  });

  it("a guest never gets the start controls and sees the waiting-for-host notice", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, roundsOptionId(10))).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);
    act(() => r.unmount());
  });

  it("the host starts the game and picks the rounds; rounds-updated from the server is applied", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, roundsOptionId(20));
    expect(emitted("set-rounds")).toEqual([{ gameCode: "K7MQ4X", rounds: 20 }]);
    expect(mockCtx.setRoundsOfGame).toHaveBeenLastCalledWith(20);

    pressId(r, TEST_IDS.startGameButton);
    expect(emitted("start-game")).toEqual([{ gameCode: "K7MQ4X" }]);

    act(() => mockSocket.fire("rounds-updated", 15));
    expect(mockCtx.setRoundsOfGame).toHaveBeenLastCalledWith(15);
    act(() => r.unmount());
  });

  it("game-started hands the players to the game and opens the game screen", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    const players = [player("alice", true), player("bob")];
    act(() => mockSocket.fire("game-started", players));
    expect(mockCtx.setPlayersProvider).toHaveBeenCalledWith(players);
    expect(mockReplace).toHaveBeenCalledWith("/screens/GameScreen");
    act(() => r.unmount());
  });

  it("another player removed by the host leaves the list; nothing else happens", async () => {
    const r = await mount([player("alice"), player("bob", true), player("carol")]);
    act(() => mockSocket.fire("player-removed", player("carol")));
    expect(hasId(r, lobbyPlayerId("carol"))).toBe(false);
    expect(hasId(r, lobbyPlayerId("alice"))).toBe(true);
    expect(mockCtx.endSocket).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

describe("WaitingRoom: ways out (EXP-063)", () => {
  it("kicked: forgets the rejoin token, ends the socket and goes home (no leave-room)", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    act(() => mockSocket.fire("player-removed", player("alice")));
    expect(mockCtx.clearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockCtx.endSocket).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/");
    expect(emitted("leave-room")).toHaveLength(0);
    act(() => r.unmount());
  });

  it("the close button leaves the room, forgets the token, ends the socket and goes home", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    act(() => mockClose.onPress!());
    expect(emitted("leave-room")).toHaveLength(1);
    expect(mockCtx.clearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockCtx.endSocket).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });

  it("unmounting removes every lobby listener (the game screen attaches its own)", async () => {
    const r = await mount([player("alice", true)]);
    expect(mockSocket.handlers.size).toBeGreaterThan(0);
    act(() => r.unmount());
    expect(mockSocket.handlers.size).toBe(0);
  });
});

describe("WaitingRoom: room code (EXP-198)", () => {
  it("shows the room's alphanumeric code in the lobby", async () => {
    const r = await mount([player("alice", true)]);
    expect(r.root.find((n) => n.props.testID === TEST_IDS.lobbyGameCode && typeof n.type === "string").props.children).toBe("K7MQ4X");
    act(() => r.unmount());
  });

  it("takes the invite deep link's code in any case", async () => {
    mockRoute.gameCode = null;
    mockRoute.params = { code: " k7mq4x " };
    const r = await mount();
    expect(mockCtx.setGameCode).toHaveBeenCalledWith("K7MQ4X");
    act(() => r.unmount());
  });

  it("ignores a malformed deep link code", async () => {
    mockRoute.gameCode = null;
    mockRoute.params = { code: "12345O" };
    const r = await mount();
    expect(mockCtx.setGameCode).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
