import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { lobbyPlayerId, roundsOptionId } from "../src/utils/testIds";
import { ROUND_OPTIONS } from "../src/utils/protocolLimits";

// EXP-027: the server never sends socket ids, so the host kicks a player by username.

const mockSocket = new FakeSocket();
// Captures the confirm dialog's props so the test can press "Remove"
const mockAlertProps: { current: any } = { current: null };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice",
    setRoundsOfGame: jest.fn(), roundsOfGame: 10, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
  }),
}));
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
  }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/src/components/CloseButton", () => () => null);
jest.mock("@/src/components/AnimatedDot", () => () => null);
jest.mock("@/src/components/modals/AlertModal", () => (props: any) => { mockAlertProps.current = props; return null; });
jest.mock("@/src/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/src/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

// Players exactly as the server sends them (public allowlist: no socketId)
const player = (username: string, isHost: boolean) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });
const players = [player("alice", true), player("bob", false)];

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
});

describe("WaitingRoom: host removes a player", () => {
  it("emits remove-player with the player's username", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
    await act(async () => { await Promise.resolve(); });
    act(() => mockSocket.fire("room-of-game", { success: true, room: { gameCode: "ABC123", players, rounds: 10 }, rejoinToken: "tok-123" }));

    act(() => { r.root.findByProps({ testID: lobbyPlayerId("bob") }).props.onPress(); });
    expect(mockAlertProps.current.visible).toBe(true);
    mockSocket.emitted = [];
    act(() => mockAlertProps.current.onConfirm());
    expect(mockSocket.emitted).toEqual([["remove-player", { gameCode: "ABC123", username: "bob" }]]);
    act(() => r.unmount());
  });
});

// ── Lobby texts and screen reader (EXP-381, EXP-383) ──

async function mountWith(roomPlayers: ReturnType<typeof player>[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  act(() => mockSocket.fire("room-of-game", { success: true, room: { gameCode: "ABC123", players: roomPlayers, rounds: 10 }, rejoinToken: "tok-123" }));
  return r;
}

describe("WaitingRoom: kick confirmation text (EXP-381)", () => {
  it("hands the dialog the {name} template and the @name to highlight in it", async () => {
    const r = await mountWith(players);
    act(() => { r.root.findByProps({ testID: lobbyPlayerId("bob") }).props.onPress(); });
    expect(mockAlertProps.current.title).toBe("Remove player");
    expect(mockAlertProps.current.message).toBe("Are you sure you want to remove {name} from the room?");
    expect(mockAlertProps.current.highlightedText).toBe("@bob");
    act(() => r.unmount());
  });

  it("a guest waits «for the host»", async () => {
    const r = await mountWith([player("bob", true), player("alice", false)]);
    const texts = r.root.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children);
    expect(texts).toContain("Waiting for the host");
    act(() => r.unmount());
  });
});

describe("WaitingRoom: rounds pills for screen readers (EXP-383)", () => {
  const pill = (r: TestRenderer.ReactTestRenderer, rounds: number) =>
    r.root.findAll((n) => n.props.testID === roundsOptionId(rounds) && typeof n.props.onPress === "function")[0];

  it("are buttons named with their round count that say which one is picked", async () => {
    const r = await mountWith(players);
    for (const rounds of ROUND_OPTIONS) {
      const p = pill(r, rounds);
      expect(p.props.accessibilityRole).toBe("button");
      expect(p.props.accessibilityLabel).toBe(`${rounds} Rounds`);
      expect(p.props.accessibilityState).toEqual({ disabled: false, selected: rounds === 10 });
    }
    act(() => r.unmount());
  });
});
