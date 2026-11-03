import React from "react";
import { Text } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import GameScreen from "../app/screens/GameScreen";
import { TEST_IDS } from "../src/utils/testIds";
import { SERVER_UNREACHABLE_AFTER_MS } from "../src/hooks/useServerUnreachable";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-429: a game opened (or going on) with no network, the server down or Render cold-starting used to show the
// "Reconnecting…" pill (and the loading spinner) for ever. After SERVER_UNREACHABLE_AFTER_MS without a connection the
// pill says the server can't be reached, with Try again; the socket keeps retrying and a connection carries on.

jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockReplace = jest.fn();
const mockEndSocket = jest.fn();
const mockParams: { current: Record<string, string> } = { current: {} };
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams.current,
  useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => {
  const actual = jest.requireActual("../src/providers/GameContext");
  return {
    ...actual,
    useGameContext: () => ({
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: mockEndSocket,
      playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
      plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    }),
  };
});
jest.mock("../src/providers/PhotoContext", () => ({ usePhotoContext: () => ({ getRandomPhoto: jest.fn(), setPhotoUri: jest.fn() }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

const shows = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

const byId = (r: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance =>
  r.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function");

/** The native view behind a testID: what the touch system reads pointerEvents from */
const hostView = (r: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance =>
  r.root.find((n) => n.props.testID === id && typeof n.type === "string");

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).map((n) => n.props.children).flat();

const wait = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();
  return r;
};

const drop = () => {
  mockSocket.connected = false;
  act(() => mockSocket.fire("disconnect", "transport close"));
};

const connect = async () => {
  mockSocket.connected = true;
  await act(async () => { mockSocket.fire("connect"); });
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockParams.current = {};
  [mockReplace, mockEndSocket].forEach((m) => m.mockClear());
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe("GameScreen: the server can't be reached (EXP-429)", () => {
  it("reopened on a game in progress with no network: the spinner gets the connection message, with Try again", async () => {
    mockParams.current = { resync: "1" };
    mockSocket.connected = false;
    const r = await mount();
    expect(shows(r, TEST_IDS.gameLoading)).toBe(true);
    expect(texts(r)).toContain(en.reconnecting);

    await wait(SERVER_UNREACHABLE_AFTER_MS - 1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);

    await wait(1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(true);
    expect(texts(r)).toEqual(expect.arrayContaining([en.gameServerUnreachable, en.gameServerUnreachableHint, en.tryAgain]));
    expect(texts(r)).not.toContain(en.reconnecting);
    // The way out stays the game's own Exit, and nothing gave up on the game
    expect(shows(r, TEST_IDS.leaveGameButton)).toBe(true);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockSocket.emittedPayloads("leave-room")).toEqual([]);
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("a connection lost mid-game says so once the wait is over", async () => {
    const r = await mount();
    drop();
    expect(shows(r, TEST_IDS.reconnectingBanner)).toBe(true);
    await wait(SERVER_UNREACHABLE_AFTER_MS);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(true);
    act(() => r.unmount());
  });

  // The pill sits over the photo and the answers: it must let every tap through. The message takes its Try again
  it("the pill lets every tap through, the message only takes its card's", async () => {
    const r = await mount();
    drop();
    expect(hostView(r, TEST_IDS.reconnectingBanner).props.pointerEvents).toBe("none");

    await wait(SERVER_UNREACHABLE_AFTER_MS);
    expect(hostView(r, TEST_IDS.reconnectingBanner).props.pointerEvents).toBe("box-none");
    const card = hostView(r, TEST_IDS.gameServerUnreachable).props.pointerEvents;
    expect(card).not.toBe("none");
    expect(card).not.toBe("box-none");
    act(() => r.unmount());
  });

  it("Try again keeps the socket trying and gives it the full wait again", async () => {
    const r = await mount();
    drop();
    await wait(SERVER_UNREACHABLE_AFTER_MS);

    act(() => byId(r, TEST_IDS.gameServerUnreachableRetry).props.onPress());
    expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);
    expect(texts(r)).toContain(en.reconnecting);

    await wait(SERVER_UNREACHABLE_AFTER_MS - 1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);
    await wait(1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(true);
    act(() => r.unmount());
  });

  it("a connection that comes while the message shows rejoins and clears the banner", async () => {
    const r = await mount();
    drop();
    await wait(SERVER_UNREACHABLE_AFTER_MS);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(true);

    mockSocket.emitted = [];
    await connect();
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);
    expect(shows(r, TEST_IDS.reconnectingBanner)).toBe(false);
    expect(mockSocket.emittedPayloads("join-create-game")).toEqual([
      { gameCode: "123456", username: "bob", rejoinToken: "tok-123" },
    ]);
    act(() => r.unmount());
  });

  it("a new drop after reconnecting starts the wait over", async () => {
    const r = await mount();
    drop();
    await wait(SERVER_UNREACHABLE_AFTER_MS);
    await connect();
    drop();
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);
    await wait(SERVER_UNREACHABLE_AFTER_MS - 1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(false);
    await wait(1);
    expect(shows(r, TEST_IDS.gameServerUnreachable)).toBe(true);
    act(() => r.unmount());
  });

  it("has the message in both languages", () => {
    expect(en.gameServerUnreachable).toMatch(/connection/i);
    expect(es.gameServerUnreachable).toMatch(/conexión/i);
    expect(en.gameServerUnreachableHint).toMatch(/reconnect/i);
    expect(es.gameServerUnreachableHint).toMatch(/reconectar/i);
  });
});
