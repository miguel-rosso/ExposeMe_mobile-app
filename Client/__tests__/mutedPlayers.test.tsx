import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { endMutesOutsideRoom, useMutedPlayers, withoutMuted, NOBODY_MUTED } from "../src/hooks/useMutedPlayers";
import { lobbyMuteId, lobbyPlayerId } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-422 / DEC-052 A: any player can mute another one on this device. A mute lasts for the room's lifetime: it is
// shared by the lobby and the game screen, survives a reconnect, and is gone once the player leaves the room. In the
// lobby a muted player's chat bubbles are hidden, those already on screen included; unmuting shows their next ones.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// The lobby's context: its room code changes per test, so each test starts with nobody muted
const mockSocket = new FakeSocket();
let mockGameCode = "ROOM01";
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(), gameCode: mockGameCode, setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice", usernameLoaded: true,
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
let mockT: typeof en | typeof es = en;
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/src/components/CloseButton", () => () => null);
jest.mock("@/src/components/AnimatedDot", () => () => null);
// Whether the remove-player confirmation is open
const mockAlertVisible = { current: false };
jest.mock("@/src/components/modals/AlertModal", () => (props: { visible: boolean }) => {
  mockAlertVisible.current = props.visible;
  return null;
});
jest.mock("@/src/components/SuccessAlert", () => () => null);
// A bubble on screen, by its sender and text
jest.mock("@/src/components/IngameComunication/ChatMessage", () => (props: { username: string; message: string }) =>
  require("react").createElement("ChatBubble", { username: props.username, message: props.message }));

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockT = en;
  mockSocket.reset();
});

// ── The mute store ──

/** Renders useMutedPlayers for `room` and exposes its latest result */
const mountMutes = (room: string | null) => {
  const result: { current: ReturnType<typeof useMutedPlayers> } = { current: undefined as never };
  const Probe = () => {
    result.current = useMutedPlayers(room);
    return null;
  };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<Probe />); });
  return { result, unmount: () => act(() => r.unmount()) };
};

describe("useMutedPlayers (EXP-422)", () => {
  it("mutes and unmutes a player, seen at once by every screen of that room", () => {
    const lobby = mountMutes("ROOM10");
    const game = mountMutes("ROOM10");
    expect(game.result.current.muted).toBe(NOBODY_MUTED);

    act(() => lobby.result.current.toggle("bob"));
    expect([...game.result.current.muted]).toEqual(["bob"]);
    act(() => game.result.current.toggle("carol"));
    act(() => game.result.current.toggle("bob"));
    expect([...lobby.result.current.muted]).toEqual(["carol"]);
    lobby.unmount();
    game.unmount();
  });

  it("is kept from the lobby to the game screen while the app stays in the room", () => {
    const lobby = mountMutes("ROOM11");
    act(() => lobby.result.current.toggle("bob"));
    lobby.unmount();
    // The game context sets the same room again (e.g. the rejoin's room-of-game)
    act(() => endMutesOutsideRoom("ROOM11"));

    const game = mountMutes("ROOM11");
    expect(game.result.current.muted.has("bob")).toBe(true);
    game.unmount();
  });

  it("ends with the stay in the room: no room, or another one, forgets them", () => {
    const game = mountMutes("ROOM12");
    act(() => game.result.current.toggle("bob"));
    act(() => endMutesOutsideRoom(null));
    expect(game.result.current.muted.size).toBe(0);

    act(() => game.result.current.toggle("bob"));
    act(() => endMutesOutsideRoom("ROOM13"));
    expect(game.result.current.muted.size).toBe(0);
    game.unmount();
  });

  it("without a room nobody is muted and nothing can be", () => {
    const noRoom = mountMutes(null);
    act(() => noRoom.result.current.toggle("bob"));
    act(() => noRoom.result.current.mute("bob"));
    expect(noRoom.result.current.muted.size).toBe(0);
    noRoom.unmount();
  });

  // EXP-438: reporting a player mutes them, whether or not they already were (never unmutes, unlike toggle)
  it("mute mutes a player and leaves one already muted as is (the same set: nothing re-renders)", () => {
    const game = mountMutes("ROOM14");
    act(() => game.result.current.mute("bob"));
    const afterFirst = game.result.current.muted;
    expect([...afterFirst]).toEqual(["bob"]);
    act(() => game.result.current.mute("bob"));
    expect(game.result.current.muted).toBe(afterFirst);
    act(() => game.result.current.mute("carol"));
    expect([...game.result.current.muted]).toEqual(["bob", "carol"]);
    game.unmount();
  });

  it("withoutMuted keeps the same list when nobody in it is muted", () => {
    const list = [{ username: "bob" }, { username: "carol" }];
    expect(withoutMuted(list, new Set(["dave"]))).toBe(list);
    expect(withoutMuted(list, new Set(["bob"]))).toEqual([{ username: "carol" }]);
  });
});

// ── The lobby ──

const player = (username: string, isHost: boolean) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });
const LOBBY = [player("alice", true), player("bob", false), player("carol", false)];

const mountLobby = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  act(() => mockSocket.fire("room-of-game", {
    success: true, room: { gameCode: mockGameCode, players: LOBBY, rounds: 10 }, rejoinToken: "tok-123",
  }));
  return r;
};
/** The innermost touchable with that testID */
const pressable = (root: ReactTestInstance, id: string) => {
  const target = root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function").pop();
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  return target;
};
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id).length > 0;
const bubbles = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "ChatBubble").map((n) => `${n.props.username}: ${n.props.message}`);
const chat = (username: string, message: string) => act(() => mockSocket.fire("chat-message", { username, message }));

describe("WaitingRoom: muting a player (EXP-422)", () => {
  it("every other player's row has a mute button that shows the mute, named for screen readers (en/es)", async () => {
    mockGameCode = "ROOM30";
    const r = await mountLobby();
    expect(has(r.root, lobbyMuteId("alice"))).toBe(false); // me
    const bob = () => pressable(r.root, lobbyMuteId("bob"));
    expect(bob().props.accessibilityLabel).toBe("Mute bob");
    expect(bob().props.accessibilityState).toEqual({ selected: false });

    act(() => bob().props.onPress());
    expect(bob().props.accessibilityLabel).toBe("Unmute bob");
    expect(bob().props.accessibilityState).toEqual({ selected: true });
    expect(bob().findByType("Icon" as never).props.name).toBe("volume-off");
    // Muting is not removing: the row and the host's remove tap stay
    expect(has(r.root, lobbyPlayerId("bob"))).toBe(true);
    act(() => r.unmount());

    mockT = es;
    const again = await mountLobby();
    expect(pressable(again.root, lobbyMuteId("bob")).props.accessibilityLabel).toBe("Quitar silencio a bob");
    expect(pressable(again.root, lobbyMuteId("carol")).props.accessibilityLabel).toBe("Silenciar a carol");
    act(() => again.unmount());
  });

  it("the mute button is no part of the row's touchable, so screen readers reach it (and a tap never asks to remove)", async () => {
    mockGameCode = "ROOM32";
    const r = await mountLobby();
    const button = pressable(r.root, lobbyMuteId("bob"));
    // From the button's outermost element (the touchable, not the native view it renders) up
    const outermost = r.root.findAll((n) => n.props.testID === lobbyMuteId("bob"))[0];
    for (let n = outermost.parent; n; n = n.parent) {
      expect(n.props.accessible).not.toBe(true);
      expect(typeof n.props.onPress).not.toBe("function");
    }
    // The host's tap on the row still asks to remove
    expect(typeof pressable(r.root, lobbyPlayerId("bob")).props.onPress).toBe("function");
    act(() => button.props.onPress());
    expect(mockAlertVisible.current).toBe(false);
    act(() => r.unmount());
  });

  it("hides a muted player's chat, the bubbles already on screen too; unmuting shows their next messages", async () => {
    mockGameCode = "ROOM31";
    const r = await mountLobby();
    chat("bob", "hello");
    chat("carol", "hi");
    expect(bubbles(r)).toEqual(["bob: hello", "carol: hi"]);

    act(() => pressable(r.root, lobbyMuteId("bob")).props.onPress());
    expect(bubbles(r)).toEqual(["carol: hi"]);
    chat("bob", "still here?");
    chat("carol", "yes");
    expect(bubbles(r)).toEqual(["carol: hi", "carol: yes"]);

    act(() => pressable(r.root, lobbyMuteId("bob")).props.onPress());
    // What they sent while muted stays hidden; what they send now shows
    expect(bubbles(r)).toEqual(["carol: hi", "carol: yes"]);
    chat("bob", "back");
    expect(bubbles(r)).toEqual(["carol: hi", "carol: yes", "bob: back"]);
    act(() => r.unmount());
  });
});
