import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { KICKED_BY_HOST_MESSAGE } from "../app/utils/serverMessage";

// EXP-180 / EXP-036: when the server refuses the join (room-of-game) or the connection itself (connect_error),
// the lobby sends the player home with the server's reason; the home screen shows it translated.

const mockSocket = new FakeSocket();
const mockReplace = jest.fn();
const mockClearRejoinToken = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "bob",
    setRoundsOfGame: jest.fn(), roundsOfGame: 10, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-123", clearRejoinToken: mockClearRejoinToken,
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
  mockSocket.active = true;
  mockReplace.mockClear();
  mockClearRejoinToken.mockClear();
});

describe("WaitingRoom: the server refuses us (EXP-180)", () => {
  it("goes home with the room-of-game message, translated there", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", { success: false, message: "Too many attempts" }));
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/", params: { message: "Too many attempts" } });
    expect(mockClearRejoinToken).not.toHaveBeenCalled(); // e.g. rate-limited: the token may still rejoin later
    act(() => r.unmount());
  });

  // EXP-337: kicked while offline, the app comes back with its stored token; the server refuses it. The token is
  // forgotten, so joining again by hand (code + name) enters as a new player instead of being refused again (DEC-016)
  it("kicked while offline: the refused rejoin forgets the token and goes home telling why", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", { success: false, message: KICKED_BY_HOST_MESSAGE }));
    expect(mockClearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/", params: { message: KICKED_BY_HOST_MESSAGE } });
    act(() => r.unmount());
  });

  it("goes home with the reason when the server refuses the connection (socket.io won't retry)", async () => {
    const r = await mount();
    mockSocket.active = false;
    act(() => mockSocket.fire("connect_error", new Error("Too many connections")));
    expect(mockReplace).toHaveBeenCalledWith({ pathname: "/", params: { message: "Too many connections" } });
    act(() => r.unmount());
  });

  it("keeps waiting on a network error: socket.io is still retrying", async () => {
    const r = await mount();
    act(() => mockSocket.fire("connect_error", new Error("xhr poll error")));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
