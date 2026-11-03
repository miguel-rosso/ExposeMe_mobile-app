import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS, lobbyPlayerId, playerOptionId } from "../app/utils/testIds";
import en from "../app/i18n/en";
import { GameStateSnapshot } from "../app/models/interfaces";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import WaitingRoom from "../app/screens/WaitingRoom";
import GameScreen from "../app/screens/GameScreen";

// EXP-187: from the lobby into the game with the server's real event sequence, both screens on one shared socket and
// one game context (as in the app): room-of-game -> start-game -> game-started (players, rounds, game number) -> the
// game screen takes over the socket and says im-ready -> waiting-photo -> round-start draws the first round.

const mockSocket = new FakeSocket();

// ── Game context and router: a tiny store shared by both screens, like GameProvider and expo-router ──

const LOBBY_ROUTE = "/screens/WaitingRoom";
const GAME_ROUTE = "/screens/GameScreen";

interface MockAppState {
  route: string;
  routeParams: Record<string, string>;
  gameCode: string | null;
  roundsOfGame: number;
  playersProvider: unknown[];
  /** GameContext's planted photo: the picked one, and whether the server acked it */
  plantedPhotoUri: string | null;
  plantedPhotoSent: boolean;
}
const NO_PLANTED_PHOTO = { plantedPhotoUri: null, plantedPhotoSent: false };
const mockStore = {
  state: { route: LOBBY_ROUTE, routeParams: {}, gameCode: null, roundsOfGame: 10, playersProvider: [], ...NO_PLANTED_PHOTO } as MockAppState,
  listeners: new Set<() => void>(),
  set(patch: Partial<MockAppState>) {
    mockStore.state = { ...mockStore.state, ...patch };
    mockStore.listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    mockStore.listeners.add(l);
    return () => { mockStore.listeners.delete(l); };
  },
};
const mockUseStore = () => require("react").useSyncExternalStore(mockStore.subscribe, () => mockStore.state) as MockAppState;
type MockHref = string | { pathname: string; params?: Record<string, string> };
const mockReplace = jest.fn((href: MockHref) => {
  if (typeof href === "string") mockStore.set({ route: href, routeParams: {} });
  else mockStore.set({ route: href.pathname, routeParams: href.params ?? {} });
});

// GameContext's plantPhoto contract (gameContextPlanted.test): the picked photo is uploaded, and plant-photo goes only
// if it is still the picked one once the upload is done (a photo replaced or dropped meanwhile is never sent)
const mockPlantPhoto = jest.fn(async () => {
  const uri = mockStore.state.plantedPhotoUri;
  if (!uri) return false;
  await Promise.resolve(); // the upload
  if (mockStore.state.plantedPhotoUri !== uri) return false;
  mockSocket.emit("plant-photo", { photoUrl: uri });
  return true;
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: jest.fn() }),
  useLocalSearchParams: () => mockStore.state.routeParams,
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
  useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const state = mockUseStore();
    return {
      socket: mockSocket, username: "bob", gameCode: state.gameCode, roundsOfGame: state.roundsOfGame,
      playersProvider: state.playersProvider, plantedPhotoUri: state.plantedPhotoUri, plantedPhotoSent: state.plantedPhotoSent,
      setGameCode: (gameCode: string | null) => mockStore.set({ gameCode }),
      setRoundsOfGame: (roundsOfGame: number) => mockStore.set({ roundsOfGame }),
      setPlayersProvider: (playersProvider: unknown[]) => mockStore.set({ playersProvider }),
      startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(),
      setPlantedPhotoUri: (plantedPhotoUri: string | null) => mockStore.set({ plantedPhotoUri, plantedPhotoSent: false }),
      plantPhoto: mockPlantPhoto,
      saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-bob", clearRejoinToken: jest.fn(),
      takeInviteOverRoomScreen: () => null,
    };
  },
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
    pickGamePhoto: jest.fn(),
    setPhotoUri: jest.fn(),
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
jest.mock("@/app/components/PhotoComponent", () => "PhotoComponent");
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => "ProgressBar");

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

// ── Server data, as the server sends it ──────────────────

const ROOM_CODE = "K7MQ4X";
const ROOM_ROUNDS = 15;
const PHOTO_WAIT_MS = 15_000;
const ANSWERING_MS = 7_700;
const FIRST_PHOTO = "/temp/round-1.jpg";
const GAME_NUMBER = 1;
const GAME_SCREEN_AT_START = { pathname: GAME_ROUTE, params: { gameNumber: String(GAME_NUMBER) } };

// Public player data (no socketId)
const player = (username: string, isHost = false) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });
const LOBBY_PLAYERS = [player("alice", true), player("bob"), player("carol")];
const roomOfGame = {
  success: true,
  room: { gameCode: ROOM_CODE, players: LOBBY_PLAYERS, rounds: ROOM_ROUNDS, started: false },
  rejoinToken: "tok-bob",
  hasPlantedPhoto: false,
};

// ── Harness: the app's stack, showing whichever screen the router was sent to ──

const App = () => (mockUseStore().route === GAME_ROUTE ? <GameScreen /> : <WaitingRoom />);

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

let mounted: TestRenderer.ReactTestRenderer | null = null;
async function openLobby() {
  await act(async () => { mounted = TestRenderer.create(<App />); });
  await flush();
  return mounted!;
}

const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id && typeof n.type === "string").length > 0;
const hostElements = (root: ReactTestInstance, type: string) => root.findAll((n) => (n.type as unknown) === type);
const barDurations = (root: ReactTestInstance) => hostElements(root, "ProgressBar").map((n) => n.props.duration);
const texts = (root: ReactTestInstance) =>
  root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));
// Events only the lobby listens to (the game screen has its own room-of-game, player-left... listeners)
const LOBBY_ONLY_EVENTS = ["chat-message", "player-joined", "rounds-updated", "game-started"];
const listenerCounts = (events: string[]) => Object.fromEntries(events.map((ev) => [ev, mockSocket.listenerCount(ev)]));

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockReplace.mockClear();
  mockStore.state = { route: LOBBY_ROUTE, routeParams: {}, gameCode: ROOM_CODE, roundsOfGame: 10, playersProvider: [], ...NO_PLANTED_PHOTO };
});

describe("Lobby -> game with the server's events (EXP-187)", () => {
  it("game-started opens the game screen on the same socket, which says ready and draws the first round", async () => {
    const r = await openLobby();
    expect(mockSocket.emittedPayloads("join-create-game")).toEqual([{ gameCode: ROOM_CODE, username: "bob", rejoinToken: "tok-bob" }]);
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    expect(has(r.root, lobbyPlayerId("carol"))).toBe(true);
    expect(has(r.root, TEST_IDS.lobbyWaiting)).toBe(true); // a guest waits for the host

    // The host started: the server sends the public players, the rounds and the game's number to the whole room
    await act(async () => { mockSocket.fire("game-started", LOBBY_PLAYERS, ROOM_ROUNDS, GAME_NUMBER); });
    await flush();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(GAME_SCREEN_AT_START);
    expect(has(r.root, TEST_IDS.lobbyGameCode)).toBe(false);
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);

    // The lobby let go of the socket; the game screen is listening and told the server it is ready, once, without
    // re-joining (a normal start needs no state resync)
    expect(listenerCounts(LOBBY_ONLY_EVENTS)).toEqual(Object.fromEntries(LOBBY_ONLY_EVENTS.map((ev) => [ev, 0])));
    expect(mockSocket.listenerCount("room-of-game")).toBe(1); // the game screen's own (rejoin answers)
    expect(mockSocket.listenerCount("waiting-photo")).toBe(1);
    expect(mockSocket.listenerCount("round-start")).toBe(1);
    expect(mockSocket.emittedPayloads("im-ready")).toEqual([{ gameCode: ROOM_CODE, username: "bob" }]);
    expect(mockSocket.emittedPayloads("join-create-game")).toHaveLength(1);

    // First phase: someone is choosing a photo, with the room's rounds from the lobby and the server's wait
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: PHOTO_WAIT_MS, gameNumber: GAME_NUMBER }));
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(false);
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(texts(r.root)).toContain(en.roundOf.replace("{round}", "1").replace("{total}", String(ROOM_ROUNDS)));
    expect(barDurations(r.root)).toEqual([PHOTO_WAIT_MS]);

    // The photo arrives: every player from game-started is an answer option, under the round's photo and bar
    act(() => mockSocket.fire("round-start", { photo: FIRST_PHOTO, round: 1, duration: ANSWERING_MS }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(false);
    LOBBY_PLAYERS.forEach(({ username }) => expect(has(r.root, playerOptionId(username))).toBe(true));
    expect(barDurations(r.root)).toEqual([ANSWERING_MS]);
    const [photo] = hostElements(r.root, "PhotoComponent");
    expect(photo.props.photoUrl).toMatch(new RegExp(`${FIRST_PHOTO}$`));
  });

  it("the host's start button asks the server to start, and only the server's game-started opens the game", async () => {
    const r = await openLobby();
    const hostRoom = { ...roomOfGame, room: { ...roomOfGame.room, players: [player("bob", true), player("alice")] } };
    act(() => mockSocket.fire("room-of-game", hostRoom));

    act(() => { r.root.find((n) => n.props.testID === TEST_IDS.startGameButton && typeof n.props.onPress === "function").props.onPress(); });
    expect(mockSocket.emittedPayloads("start-game")).toEqual([expect.any(Function)]); // only the ack (EXP-379)
    expect(mockReplace).not.toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.startGameButton)).toBe(true);

    await act(async () => { mockSocket.fire("game-started", hostRoom.room.players, ROOM_ROUNDS, GAME_NUMBER); });
    await flush();
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(mockSocket.emittedPayloads("im-ready")).toHaveLength(1);

    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: PHOTO_WAIT_MS }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
  });

  it("a player who left before the start is not an answer option (the game uses game-started's list, not the lobby's)", async () => {
    const r = await openLobby();
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    const startedWith = LOBBY_PLAYERS.filter((p) => p.username !== "carol");
    await act(async () => { mockSocket.fire("game-started", startedWith, ROOM_ROUNDS, GAME_NUMBER); });
    await flush();

    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: PHOTO_WAIT_MS }));
    act(() => mockSocket.fire("round-start", { photo: FIRST_PHOTO, round: 1, duration: ANSWERING_MS }));
    expect(has(r.root, playerOptionId("alice"))).toBe(true);
    expect(has(r.root, playerOptionId("bob"))).toBe(true);
    expect(has(r.root, playerOptionId("carol"))).toBe(false);
  });
});

// EXP-289: back to a game in progress ("Join" after closing the app, or "Play again" into a started game), the lobby
// opens the game screen on the snapshot it got, and the game screen asks again for its own. Until that one arrives its
// phase is unknown: a neutral loader, never the ready phase's "are you ready?".
describe("Lobby -> game in progress (EXP-289)", () => {
  const startedRoomOfGame = { ...roomOfGame, room: { ...roomOfGame.room, started: true } };
  const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
    started: true, gameNumber: 1, phase: "answering", round: 3, totalRounds: ROOM_ROUNDS, photo: FIRST_PHOTO, correctAnswer: null,
    yourGuess: null, duration: ANSWERING_MS, phaseTotal: ANSWERING_MS, held: false, holdsLeft: 3, pause: null, scores: [],
    players: LOBBY_PLAYERS, roundOptions: [], ...over,
  });
  // The lobby's snapshot of the started game opens the game screen, which asks the server again
  async function rejoinGameInProgress() {
    const r = await openLobby();
    act(() => mockSocket.fire("room-of-game", startedRoomOfGame));
    await act(async () => { mockSocket.fire("game-state", snapshot()); });
    await flush();
    expect(has(r.root, TEST_IDS.lobbyGameCode)).toBe(false);
    expect(mockSocket.emittedPayloads("join-create-game")).toHaveLength(2);
    return r;
  }

  it("shows a neutral loader, not 'are you ready?', until the game screen's snapshot draws the phase", async () => {
    const r = await rejoinGameInProgress();
    expect(has(r.root, TEST_IDS.gameLoading)).toBe(true);
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(false);
    expect(texts(r.root)).not.toContain(en.waitingEveryoneReady);
    const [loader] = r.root.findAll((n) => n.props.testID === TEST_IDS.gameLoading && typeof n.type === "string");
    expect(loader.props.accessibilityLabel).toBe(en.loadingGame);

    act(() => mockSocket.fire("game-state", snapshot()));
    expect(has(r.root, TEST_IDS.gameLoading)).toBe(false);
    LOBBY_PLAYERS.forEach(({ username }) => expect(has(r.root, playerOptionId(username))).toBe(true));
  });

  it("keeps 'are you ready?' for a game really in its ready phase", async () => {
    const r = await rejoinGameInProgress();
    act(() => mockSocket.fire("game-state", snapshot({ phase: null, round: 0, photo: null, duration: 0, phaseTotal: 0 })));
    expect(has(r.root, TEST_IDS.gameLoading)).toBe(false);
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
  });

  it("a game opened by game-started is in its ready phase: 'are you ready?' at once, no loader", async () => {
    const r = await openLobby();
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    await act(async () => { mockSocket.fire("game-started", LOBBY_PLAYERS, ROOM_ROUNDS, GAME_NUMBER); });
    await flush();
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(has(r.root, TEST_IDS.gameLoading)).toBe(false);
  });
});

// EXP-384: I planted a photo for game 1 and dropped in its ready phase, before its first waiting-photo. The others
// played game 1 to its end and the host started game 2 before I came back. The game screen opened by game-started
// knows it shows game 1, so the rejoin's snapshot of game 2 hands over to it (through the lobby) and the photo picked
// for game 1 is dropped, not planted in game 2.
describe("Lobby -> game, rejoining in the ready phase (EXP-384)", () => {
  const OLD_PLANTED = "file:///planted-for-game-1.jpg";
  // The rejoin's room-of-game: a started game in its ready phase, without my planted photo
  const startedRoomOfGame = {
    ...roomOfGame, hasPlantedPhoto: false, room: { ...roomOfGame.room, started: true, phase: null, round: 0 },
  };
  const readySnapshot = (gameNumber: number): GameStateSnapshot => ({
    started: true, gameNumber, phase: null, round: 0, totalRounds: ROOM_ROUNDS, photo: null, correctAnswer: null,
    yourGuess: null, duration: 0, phaseTotal: 0, held: false, holdsLeft: 3, pause: null, scores: [],
    players: LOBBY_PLAYERS, roundOptions: [],
  });

  /** Game 1 opened from game-started with my planted photo acked, then my socket drops before its first round */
  async function dropInReadyPhase() {
    const r = await openLobby();
    act(() => mockSocket.fire("room-of-game", roomOfGame));
    act(() => mockStore.set({ plantedPhotoUri: OLD_PLANTED, plantedPhotoSent: true }));
    await act(async () => { mockSocket.fire("game-started", LOBBY_PLAYERS, ROOM_ROUNDS, GAME_NUMBER); });
    await flush();
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    act(() => { mockSocket.connected = false; mockSocket.fire("disconnect", "transport close"); });
    mockSocket.emitted = [];
    mockReplace.mockClear();
    return r;
  }

  /** socket.io reconnects: the screen rejoins, and the server answers with room-of-game and its snapshot at once */
  async function rejoinTo(snapshot: GameStateSnapshot) {
    await act(async () => { mockSocket.connected = true; mockSocket.fire("connect"); });
    await flush();
    expect(mockSocket.emittedPayloads("join-create-game")).toEqual([{ gameCode: ROOM_CODE, username: "bob", rejoinToken: "tok-bob" }]);
    act(() => {
      mockSocket.fire("room-of-game", startedRoomOfGame);
      mockSocket.fire("game-state", snapshot);
    });
    await flush();
  }

  it("a snapshot of the next game hands over to it and drops the photo planted for this one", async () => {
    await dropInReadyPhase();
    await rejoinTo(readySnapshot(GAME_NUMBER + 1));
    expect(mockReplace).toHaveBeenCalledWith(LOBBY_ROUTE);
    expect(mockStore.state.plantedPhotoUri).toBeNull();
    expect(mockSocket.emittedPayloads("plant-photo")).toEqual([]);
    // Not game 2's im-ready from the old screen: the fresh game screen sends it
    expect(mockSocket.emittedPayloads("im-ready")).toEqual([]);
  });

  it("a snapshot of this game's ready phase stays on it and plants the photo the server lost again", async () => {
    const r = await dropInReadyPhase();
    await rejoinTo(readySnapshot(GAME_NUMBER));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(mockStore.state.plantedPhotoUri).toBe(OLD_PLANTED);
    expect(mockSocket.emittedPayloads("plant-photo")).toEqual([{ photoUrl: OLD_PLANTED }]);
    // The ready phase's snapshot sends im-ready again (the screen's own, sent offline, was deferred to it)
    expect(mockSocket.emittedPayloads("im-ready")).toHaveLength(1);
  });
});
