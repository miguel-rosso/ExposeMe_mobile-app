import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { TEST_IDS, lobbyPlayerId, lobbyPlayerOfflineId } from "../app/utils/testIds";
import { isHostIn, withConnection, withHost, withoutPlayer } from "../app/utils/roomPlayers";
import type { GameContextProps, Player } from "../app/models/interfaces";

// EXP-157: a host gone from the lobby hands the role over (new-host), so the host is whoever has the flag, not the
// first player; gone players are shown as disconnected (player-connection).

const mockSocket = new FakeSocket();
// Captures the confirm dialog's props so the test can press "Remove"
const mockAlertProps: { current: any } = { current: null };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
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

  it("withoutPlayer drops only that player, withHost leaves a single host", () => {
    const players = [player("alice", true), player("bob", false), player("carol", false)];
    expect(withoutPlayer(players, "bob").map((p) => p.username)).toEqual(["alice", "carol"]);
    expect(withoutPlayer(players, "nobody")).toEqual(players);
    expect(withHost(players, "carol").map((p) => p.isHost)).toEqual([false, false, true]);
  });

  it("withConnection only changes that player", () => {
    const out = withConnection([player("alice", true), player("bob", false)], "bob", false);
    expect(out.map((p) => p.connected)).toEqual([true, false]);
  });
});

// EXP-138: the players setter is a React state setter, so callers can derive the next list from the latest one.
// Type-level check (tsc --noEmit covers __tests__): fails to compile if the setter loses functional updates.
const acceptsFunctionalUpdates: GameContextProps["setPlayersProvider"] extends React.Dispatch<React.SetStateAction<Player[]>>
  ? true
  : false = true;

describe("WaitingRoom: player list bursts (EXP-138)", () => {
  it("setPlayersProvider is typed as a state setter", () => {
    expect(acceptsFunctionalUpdates).toBe(true);
  });

  it("joins, leaves, a kick and a host change fired in one batch all apply to the latest list", async () => {
    const r = await mount([player("alice", true)]);
    act(() => {
      mockSocket.fire("player-joined", player("bob", false));
      mockSocket.fire("player-joined", player("carol", false));
      mockSocket.fire("player-joined", player("dave", false));
      mockSocket.fire("player-left", "bob");
      mockSocket.fire("player-removed", player("dave", false));
      mockSocket.fire("new-host", player("carol", true));
    });
    expect(hasId(r, lobbyPlayerId("alice"))).toBe(true);
    expect(hasId(r, lobbyPlayerId("carol"))).toBe(true);
    expect(hasId(r, lobbyPlayerId("bob"))).toBe(false);
    expect(hasId(r, lobbyPlayerId("dave"))).toBe(false);
    // carol holds the flag now: alice lost the host controls
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => r.unmount());
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
