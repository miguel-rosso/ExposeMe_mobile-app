import React from "react";
import { Text } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { TEST_IDS } from "../src/utils/testIds";
import { SERVER_UNREACHABLE_AFTER_MS } from "../src/hooks/useServerUnreachable";
import en from "../src/i18n/en";

// EXP-417: with no network, the server down or Render cold-starting, socket.io retries for ever and the lobby's loading
// overlay used to spin for ever too. After SERVER_UNREACHABLE_AFTER_MS without a connection it says the server can't
// be reached, with Try again and Back, and a connection that comes later carries on as usual.

const mockSocket = new FakeSocket();
const mockDismissTo = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockLeaveRoom = jest.fn();
const mockEndSocket = jest.fn();
const mockClearRejoinToken = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ dismissTo: mockDismissTo, push: mockPush, replace: mockReplace }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: mockEndSocket, leaveRoom: mockLeaveRoom, gameCode: "ABC123",
    setGameCode: jest.fn(), setJoinCodeDraft: jest.fn(), setPlayersProvider: jest.fn(), socket: mockSocket,
    username: "bob", usernameLoaded: true, setRoundsOfGame: jest.fn(), roundsOfGame: 5, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: jest.fn(), getRejoinToken: async () => null, clearRejoinToken: mockClearRejoinToken,
    setHomeNotice: jest.fn(), markRoomExit: jest.fn(), setInviteOverRoomScreen: jest.fn(),
  }),
}));
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/src/components/CloseButton", () => () => null);
jest.mock("@/src/components/AnimatedDot", () => () => null);
jest.mock("@/src/components/modals/AlertModal", () => () => null);
jest.mock("@/src/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/src/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await flush();
  return r;
};

const shows = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

const byId = (r: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance =>
  r.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function");

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).map((n) => n.props.children).flat();

const wait = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

/** A connection that comes in at last: socket.io's connect event (the lobby joins on it) */
const connect = async () => {
  mockSocket.connected = true;
  await act(async () => { mockSocket.fire("connect"); });
  await flush();
};

/** The connection drops: socket.io's disconnect event, and it goes back to retrying */
const drop = () => {
  mockSocket.connected = false;
  act(() => mockSocket.fire("disconnect", "transport close"));
};

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockSocket.connected = false; // no network: socket.io keeps retrying, no connect comes
  [mockDismissTo, mockPush, mockReplace, mockLeaveRoom, mockEndSocket, mockClearRejoinToken].forEach((m) => m.mockClear());
});

describe("WaitingRoom: the server can't be reached (EXP-417)", () => {
  it("swaps the spinner for the connection message, with Try again and Back, once the wait is over", async () => {
    const r = await mount();
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);

    await wait(SERVER_UNREACHABLE_AFTER_MS - 1);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);

    await wait(1);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(false);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(true);
    expect(texts(r)).toContain(en.serverUnreachable);
    expect(texts(r)).toEqual(expect.arrayContaining([en.tryAgain, en.back]));
    // The socket's own retries go on: nothing closed it, nothing left the room
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockLeaveRoom).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("Try again keeps the socket trying and gives it the full wait again", async () => {
    const r = await mount();
    await wait(SERVER_UNREACHABLE_AFTER_MS);

    act(() => byId(r, TEST_IDS.serverUnreachableRetry).props.onPress());
    expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);

    await wait(SERVER_UNREACHABLE_AFTER_MS - 1);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    await wait(1);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(true);
    act(() => r.unmount());
  });

  // Back keeps the seat: e.g. a player coming back to a game in progress on a flaky network must not leave it (nor end
  // the others' game) by giving up on this screen. Home's Join reclaims it with the kept rejoin token. EXP-339: home
  // the close button's way, never a second home pushed over the first
  it("Back goes home keeping the seat: no leave, the rejoin token stays", async () => {
    const r = await mount();
    await wait(SERVER_UNREACHABLE_AFTER_MS);

    act(() => byId(r, TEST_IDS.serverUnreachableBack).props.onPress());
    expect(mockLeaveRoom).not.toHaveBeenCalled();
    expect(mockSocket.emittedPayloads("leave-room")).toEqual([]);
    expect(mockClearRejoinToken).not.toHaveBeenCalled();
    expect(mockEndSocket).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("a connection that comes while the message shows carries on: it joins and the lobby opens", async () => {
    const r = await mount();
    await wait(SERVER_UNREACHABLE_AFTER_MS);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(true);

    await connect();
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true); // waiting for the join's answer now
    expect(mockSocket.emittedPayloads("join-create-game")).toEqual([{ gameCode: "ABC123", username: "bob" }]);

    act(() => mockSocket.fire("room-of-game", {
      success: true,
      room: { gameCode: "ABC123", players: [{ username: "bob", isHost: true }], rounds: 5, started: false, gameNumber: 0 },
    }));
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(false);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    expect(mockDismissTo).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("a connection lost before the join's answer starts the wait over, and a reconnection joins again", async () => {
    const r = await mount();
    await connect();
    expect(mockSocket.emittedPayloads("join-create-game")).toHaveLength(1);

    drop();
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);
    await wait(SERVER_UNREACHABLE_AFTER_MS);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(true);

    await connect();
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);
    expect(mockSocket.emittedPayloads("join-create-game")).toEqual([
      { gameCode: "ABC123", username: "bob" },
      { gameCode: "ABC123", username: "bob" },
    ]);
    act(() => r.unmount());
  });

  it("a connected socket waiting for the join's answer never shows the connection message", async () => {
    mockSocket.connected = true;
    const r = await mount();
    await wait(SERVER_UNREACHABLE_AFTER_MS * 2);
    expect(shows(r, TEST_IDS.lobbyLoading)).toBe(true);
    expect(shows(r, TEST_IDS.serverUnreachable)).toBe(false);
    act(() => r.unmount());
  });
});
