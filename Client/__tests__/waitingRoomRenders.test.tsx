import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FlatList } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS, lobbyPlayerId } from "../app/utils/testIds";
import type { Player } from "../app/models/interfaces";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-396: typing in the lobby chat re-renders only the chat footer, never the whole lobby, and the player list keeps
// the same row callbacks across lobby updates that don't touch the players (so its rows aren't drawn again).

const mockSocket = new FakeSocket();
// How many times WaitingRoom itself rendered: useStartGame is only called by it, once per render
const mockLobbyRenders = { count: 0 };

jest.mock("../app/hooks/useStartGame", () => {
  const actual = jest.requireActual("../app/hooks/useStartGame");
  return {
    ...actual,
    useStartGame: (...args: Parameters<typeof actual.useStartGame>) => {
      mockLobbyRenders.count++;
      return actual.useStartGame(...args);
    },
  };
});
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(), gameCode: "K7MQ4X", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice", setRoundsOfGame: jest.fn(), roundsOfGame: 10,
    plantedPhotoUri: null, setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
    getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(), takeNewRoomRequest: () => true,
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
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockLobbyRenders.count = 0;
});

const player = (username: string, isHost = false): Player => ({ username, points: 0, isHost, connected: true });

async function mount(players: Player[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  act(() => mockSocket.fire("room-of-game", {
    success: true, room: { gameCode: "K7MQ4X", players, rounds: 10, started: false }, rejoinToken: "tok-123",
  }));
  return r;
}

const chatInput = (r: TestRenderer.ReactTestRenderer) =>
  r.root.find((n) => n.props.testID === TEST_IDS.chatInput && typeof n.type === "string");
const playerList = (r: TestRenderer.ReactTestRenderer) => r.root.findByType(FlatList);

describe("WaitingRoom: render cost of the lobby (EXP-396)", () => {
  it("typing in the chat re-renders only the chat footer, not the lobby", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    const rendersBeforeTyping = mockLobbyRenders.count;

    const message = "hola a todos";
    for (let i = 1; i <= message.length; i++) {
      act(() => chatInput(r).props.onChangeText(message.slice(0, i)));
    }

    expect(chatInput(r).props.value).toBe(message);
    expect(mockLobbyRenders.count).toBe(rendersBeforeTyping);
    act(() => r.unmount());
  });

  it("the player list keeps its row callbacks across lobby updates that don't touch the players", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    const { renderItem, keyExtractor } = playerList(r).props;
    const rendersBefore = mockLobbyRenders.count;

    act(() => mockSocket.fire("chat-message", { username: "bob", message: "hey" }));

    expect(mockLobbyRenders.count).toBeGreaterThan(rendersBefore); // the lobby did render again (the bubble)
    expect(playerList(r).props.renderItem).toBe(renderItem);
    expect(playerList(r).props.keyExtractor).toBe(keyExtractor);
    act(() => r.unmount());
  });

  it("a new host gets new rows: the remove-player tap follows who is host", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    const { renderItem } = playerList(r).props;
    // Not the host: tapping bob does nothing
    expect(r.root.findAll((n) => n.props.testID === lobbyPlayerId("bob") && n.props.activeOpacity === 1).length).toBeGreaterThan(0);

    act(() => mockSocket.fire("new-host", player("alice", true)));

    expect(playerList(r).props.renderItem).not.toBe(renderItem);
    expect(r.root.findAll((n) => n.props.testID === lobbyPlayerId("bob") && n.props.activeOpacity === 0.7).length).toBeGreaterThan(0);
    act(() => r.unmount());
  });
});
