import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { GameStateSnapshot } from "../app/models/interfaces";
import { TEST_IDS } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-097: "Join" on a game that already started (the player closed the app and comes back with their rejoin
// token) must open the game screen in the server's current phase instead of leaving the player in the lobby.

const mockSocket = new FakeSocket();
const mockReplace = jest.fn();
const mockSetPlayersProvider = jest.fn();
const mockSetRoundsOfGame = jest.fn();
const mockSaveRejoinToken = jest.fn();
const mockLeaveRoom = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: mockLeaveRoom, gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: mockSetPlayersProvider, socket: mockSocket, username: "bob",
    setRoundsOfGame: mockSetRoundsOfGame, roundsOfGame: 10, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: mockSaveRejoinToken, getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
const mockCheckGalleryAccess = jest.fn(async (_: { ask: boolean }) => ({ status: "ok", limited: false, canAskAgain: true }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: (o: { ask: boolean }) => mockCheckGalleryAccess(o),
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
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

const players = [
  { username: "alice", isHost: true, connected: true },
  { username: "bob", isHost: false, connected: true },
] as any[];

const roomOfGame = { success: true, room: { gameCode: "ABC123", players, rounds: 15 }, rejoinToken: "tok-123" };

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  phase: "answering",
  round: 3,
  totalRounds: 15,
  photo: "/temp/x.jpg",
  correctAnswer: null,
  duration: 5000,
  held: false,
  pause: null,
  scores: [],
  players,
  ...over,
} as GameStateSnapshot);

const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await flush();
  return r;
};

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
  mockReplace.mockClear();
  mockSetPlayersProvider.mockClear();
  mockSetRoundsOfGame.mockClear();
});

describe("WaitingRoom: joining a game already in progress (EXP-097)", () => {
  it("opens the game screen when the rejoin snapshot says the game started", async () => {
    const r = await mount();
    expect(mockSocket.emitted).toContainEqual(["join-create-game", { gameCode: "ABC123", username: "bob", rejoinToken: "tok-123" }]);

    act(() => mockSocket.fire("room-of-game", roomOfGame));
    act(() => mockSocket.fire("game-state", snapshot()));
    expect(mockSetPlayersProvider).toHaveBeenCalledWith(players);
    expect(mockSetRoundsOfGame).toHaveBeenCalledWith(15);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    // Marked as a game in progress: the game screen waits for its own snapshot instead of painting "ready?" (EXP-289)
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/screens/GameScreen", params: { resync: "1" } });

    // A second snapshot (e.g. another reconnect) does not navigate twice
    act(() => mockSocket.fire("game-state", snapshot({ phase: "reveal" })));
    expect(mockReplace).toHaveBeenCalledTimes(1);

    // The snapshot (and a possible your-turn) went to the lobby: once the game screen takes over the socket,
    // ask the server again, on the same socket and with the token
    mockSocket.emitted = [];
    act(() => r.unmount());
    expect(mockSocket.emitted).toEqual([["join-create-game", { gameCode: "ABC123", username: "bob", rejoinToken: "tok-123" }]]);
  });

  it("stays in the lobby on a lobby snapshot (game not started, or ended while away)", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    act(() => mockSocket.fire("game-state", snapshot({ started: false, phase: null, photo: null })));
    expect(mockReplace).not.toHaveBeenCalled();

    mockSocket.emitted = [];
    act(() => r.unmount());
    expect(mockSocket.emitted).toEqual([]);
  });

  it("does not re-request state when entering the game normally via game-started", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    act(() => mockSocket.fire("game-started", players));
    expect(mockReplace).toHaveBeenCalledWith("/screens/GameScreen");

    mockSocket.emitted = [];
    act(() => r.unmount());
    expect(mockSocket.emitted).toEqual([]);
  });
});

// EXP-108: coming back to a started game, the lobby ("Waiting for host…") must never be painted between the join
// answer and the game screen: the loading screen stays until the snapshot opens the game.
describe("WaitingRoom: loading screen until the join answer settles (EXP-108)", () => {
  const isLoading = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => n.props.testID === TEST_IDS.lobbyLoading).length > 0;
  const startedRoom = { ...roomOfGame, room: { ...roomOfGame.room, started: true, phase: "answering", round: 3 } };

  it("keeps loading when room-of-game says the game started, until the snapshot opens the game screen", async () => {
    const r = await mount();
    expect(isLoading(r)).toBe(true);

    act(() => mockSocket.fire("room-of-game", startedRoom));
    expect(isLoading(r)).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();

    act(() => mockSocket.fire("game-state", snapshot()));
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/screens/GameScreen", params: { resync: "1" } });
    expect(isLoading(r)).toBe(true);
    act(() => r.unmount());
  });

  it("shows the lobby once room-of-game says the game has not started", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", { ...roomOfGame, room: { ...roomOfGame.room, started: false } }));
    expect(isLoading(r)).toBe(false);
    act(() => r.unmount());
  });

  it("shows the lobby if the snapshot after a started room-of-game says the game is over", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", startedRoom));
    act(() => mockSocket.fire("game-state", snapshot({ started: false, phase: null, photo: null })));
    expect(isLoading(r)).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

// EXP-118: no photo access / no photos → blocking overlay in the lobby (checked on mount and on every foreground);
// the only way out is leaving the room.
describe("WaitingRoom: gallery access guard (EXP-118)", () => {
  const has = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
  afterEach(() => mockCheckGalleryAccess.mockImplementation(async () => ({ status: "ok", limited: false, canAskAgain: true })));

  it("blocks the lobby without access and lets the player leave the room", async () => {
    mockCheckGalleryAccess.mockImplementation(async () => ({ status: "denied", limited: false, canAskAgain: false }));
    const r = await mount();
    await flush();
    expect(mockCheckGalleryAccess).toHaveBeenCalledWith({ ask: false });
    expect(has(r, TEST_IDS.galleryAccessModal)).toBe(true);

    act(() => r.root.find((n) => n.props.testID === TEST_IDS.galleryBackButton && typeof n.props.onPress === "function").props.onPress());
    expect(mockLeaveRoom).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });

  it("no overlay with access and photos", async () => {
    const r = await mount();
    await flush();
    expect(has(r, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
  });
});
