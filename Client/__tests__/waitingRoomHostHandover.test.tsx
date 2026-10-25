import React from "react";
import TestRenderer, { act } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { TEST_IDS, lobbyPlayerId, lobbyPlayerOfflineId } from "../app/utils/testIds";
import { isHostIn, withConnection } from "../app/utils/roomPlayers";

// EXP-157: a host gone from the lobby hands the role over (new-host), so the host is whoever has the flag, not the
// first player; gone players are shown as disconnected (player-connection).

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
// Captures the confirm dialog's props so the test can press "Remove"
const mockAlertProps: { current: any } = { current: null };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice",
    setRoundsOfGame: jest.fn(), roundsOfGame: 10, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
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
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => (props: any) => { mockAlertProps.current = props; return null; });
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

// Players exactly as the server sends them (public allowlist: no socketId)
const player = (username: string, isHost: boolean, connected = true) =>
  ({ username, points: 0, isHost, connected, lastAnswerCorrect: false, lastGuess: "" });

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
});

async function mount(players: ReturnType<typeof player>[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  act(() => mockSocket.fire("room-of-game", { success: true, room: { gameCode: "ABC123", players, rounds: 10 }, rejoinToken: "tok-123" }));
  return r;
}
const hasText = (r: TestRenderer.ReactTestRenderer, text: string) =>
  r.root.findAll((n) => typeof n.type === "string" && n.props.children === text).length > 0;
const hasId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;

describe("roomPlayers helpers", () => {
  it("isHostIn follows the host flag, not the list order", () => {
    expect(isHostIn([player("bob", false), player("alice", true)], "alice")).toBe(true);
    expect(isHostIn([player("alice", false), player("bob", true)], "alice")).toBe(false);
    expect(isHostIn([], "alice")).toBe(false);
  });

  it("withConnection only changes that player", () => {
    const out = withConnection([player("alice", true), player("bob", false)], "bob", false);
    expect(out.map((p) => p.connected)).toEqual([true, false]);
  });
});

describe("WaitingRoom: host handover and disconnected players (EXP-157)", () => {
  it("a new host who is not first in the list gets the host controls", async () => {
    const r = await mount([player("bob", true), player("alice", false)]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => mockSocket.fire("new-host", player("alice", true)));
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    act(() => { r.root.findByProps({ testID: lobbyPlayerId("bob") }).props.onPress(); });
    expect(mockAlertProps.current.visible).toBe(true); // can kick the old host
    act(() => r.unmount());
  });

  it("the old host, still first in the list, loses the controls on new-host", async () => {
    const r = await mount([player("alice", true), player("bob", false)]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    act(() => mockSocket.fire("new-host", player("bob", true)));
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => r.unmount());
  });

  it("shows gone players as disconnected, and clears it when they come back", async () => {
    const r = await mount([player("alice", true), player("bob", false, false), player("carol", false)]);
    expect(hasText(r, "disconnected")).toBe(true);
    expect(hasId(r, lobbyPlayerOfflineId("bob"))).toBe(true);
    expect(hasId(r, lobbyPlayerOfflineId("carol"))).toBe(false);
    act(() => mockSocket.fire("player-connection", { username: "bob", connected: true }));
    expect(hasText(r, "disconnected")).toBe(false);
    act(() => mockSocket.fire("player-connection", { username: "carol", connected: false }));
    expect(hasText(r, "disconnected")).toBe(true);
    act(() => r.unmount());
  });
});
