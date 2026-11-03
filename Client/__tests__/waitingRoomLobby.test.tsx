import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { TEST_IDS, lobbyPlayerId, roundsOptionId } from "../app/utils/testIds";
import { KICKED_BY_HOST_MESSAGE } from "../app/utils/serverMessage";
import { START_ACK_TIMEOUT_MS } from "../app/utils/startGame";
import { START_NOTICE_MS } from "../app/hooks/useStartGame";
import { Keyboard } from "react-native";
import { pressInviteJoin } from "../testUtils/inviteConfirm";

// EXP-063: the lobby's socket flow. Joining (with the stored rejoin token), the player list following
// player-joined / player-left / player-removed, the host's start controls (only with 2+ players), rounds, entering
// the game on game-started, and every way out (refused join, kicked, leaving) ending the socket.

const mockSocket = new FakeSocket();
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockCtx = {
  startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(), setGameCode: jest.fn(), setPlayersProvider: jest.fn(),
  setRoundsOfGame: jest.fn(), setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
  getRejoinToken: jest.fn(async (..._a: unknown[]) => "tok-123" as string | null), clearRejoinToken: jest.fn(),
  saveUsername: jest.fn(), setJoinCodeDraft: jest.fn(), takeNewRoomRequest: jest.fn(() => false), setHomeNotice: jest.fn(),
  markRoomExit: jest.fn(),
};
const mockClose: { onPress?: () => void } = {};
/** Last props of the remove-player confirmation (AlertModal) */
const mockAlert: { visible?: boolean } = {};
/** Context game code and route params (invite deep link), per test */
const mockRoute: { gameCode: string | null; params: { code?: string | string[] } } = { gameCode: "K7MQ4X", params: {} };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo }),
  useLocalSearchParams: () => mockRoute.params,
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    ...mockCtx, gameCode: mockRoute.gameCode, socket: mockSocket, username: "alice", usernameLoaded: true, roundsOfGame: 10,
    plantedPhotoUri: null,
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
jest.mock("@/app/components/CloseButton", () => (p: { onPress: () => void }) => { mockClose.onPress = p.onPress; return null; });
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => (p: { visible: boolean }) => { mockAlert.visible = p.visible; return null; });
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);
// The screen's Android hardware back handler, captured so a test can press "back"
const mockBack: { handler?: () => boolean } = {};
jest.mock("@react-native-community/hooks", () => ({
  useBackHandler: (handler: () => boolean) => { mockBack.handler = handler; },
}));

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

// Players exactly as the server sends them (public allowlist: no socketId)
const player = (username: string, isHost = false) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });

// FlatList schedules cell updates on timers: keep them on fake timers
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
  mockSocket.connected = true;
  mockReplace.mockClear();
  mockDismissTo.mockClear();
  Object.values(mockCtx).forEach((f) => f.mockClear());
  mockRoute.gameCode = "K7MQ4X";
  mockRoute.params = {};
});

const roomOfGame = (players: ReturnType<typeof player>[], extra: object = {}) =>
  ({ success: true, room: { gameCode: "K7MQ4X", players, rounds: 10, started: false }, rejoinToken: "tok-123", ...extra });

async function mount(players?: ReturnType<typeof player>[]) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  if (players) act(() => mockSocket.fire("room-of-game", roomOfGame(players)));
  return r;
}
const hasId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const pressId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  act(() => { r.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress(); });
const emitted = (ev: string) => mockSocket.emitted.filter(([e]) => e === ev).map(([, d]) => d);
const listenerCount = () => [...mockSocket.handlers.values()].reduce((n, set) => n + set.size, 0);

describe("WaitingRoom: joining (EXP-063)", () => {
  it("starts the socket and joins with the stored rejoin token, then saves the room's token and rounds", async () => {
    const r = await mount();
    expect(mockCtx.startSocket).toHaveBeenCalledTimes(1);
    expect(mockCtx.getRejoinToken).toHaveBeenCalledWith("K7MQ4X", "alice");
    expect(emitted("join-create-game")).toEqual([{ gameCode: "K7MQ4X", username: "alice", rejoinToken: "tok-123" }]);

    act(() => mockSocket.fire("room-of-game", { ...roomOfGame([player("alice", true)]), room: { gameCode: "K7MQ4X", players: [player("alice", true)], rounds: 15, started: false } }));
    expect(mockCtx.saveRejoinToken).toHaveBeenCalledWith("K7MQ4X", "alice", "tok-123");
    expect(mockCtx.setGameCode).toHaveBeenCalledWith("K7MQ4X");
    expect(mockCtx.setRoundsOfGame).toHaveBeenCalledWith(15);
    expect(hasId(r, lobbyPlayerId("alice"))).toBe(true);
    act(() => r.unmount());
  });

  it("joins without a token field when none is stored for this room", async () => {
    mockCtx.getRejoinToken.mockResolvedValueOnce(null);
    const r = await mount();
    expect(emitted("join-create-game")).toEqual([{ gameCode: "K7MQ4X", username: "alice" }]);
    act(() => r.unmount());
  });

  it("joins again on every (re)connect of the socket", async () => {
    mockSocket.connected = false;
    const r = await mount();
    expect(emitted("join-create-game")).toHaveLength(0); // not connected yet
    await act(async () => { mockSocket.fire("connect"); await Promise.resolve(); });
    expect(emitted("join-create-game")).toHaveLength(1);
    await act(async () => { mockSocket.fire("connect"); await Promise.resolve(); });
    expect(emitted("join-create-game")).toHaveLength(2);
    act(() => r.unmount());
  });

  it("a refused join ends the socket and goes home with the server's message", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", { success: false, message: "Room is full" }));
    expect(mockCtx.endSocket).toHaveBeenCalledTimes(1);
    expect(mockCtx.setHomeNotice).toHaveBeenCalledWith("Room is full");
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockCtx.setJoinCodeDraft).toHaveBeenCalledWith("K7MQ4X"); // home's join panel offers it again
    act(() => r.unmount());
  });
});

describe("WaitingRoom: player list and host controls (EXP-063)", () => {
  it("player-joined / player-left keep the list in sync, and the start controls need 2 players", async () => {
    const r = await mount([player("alice", true)]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);

    act(() => mockSocket.fire("player-joined", player("bob")));
    expect(hasId(r, lobbyPlayerId("bob"))).toBe(true);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(false);

    act(() => mockSocket.fire("player-left", "bob"));
    expect(hasId(r, lobbyPlayerId("bob"))).toBe(false);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => r.unmount());
  });

  it("a guest never gets the start controls and sees the waiting-for-host notice", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, roundsOptionId(10))).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);
    act(() => r.unmount());
  });

  it("the host starts the game and picks the rounds; rounds-updated from the server is applied", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, roundsOptionId(20));
    expect(emitted("set-rounds")).toEqual([{ gameCode: "K7MQ4X", rounds: 20 }]);
    expect(mockCtx.setRoundsOfGame).toHaveBeenLastCalledWith(20);

    pressId(r, TEST_IDS.startGameButton);
    expect(emitted("start-game")).toHaveLength(1); // no payload: the server answers through the ack (EXP-379)

    act(() => mockSocket.fire("rounds-updated", 15));
    expect(mockCtx.setRoundsOfGame).toHaveBeenLastCalledWith(15);
    act(() => r.unmount());
  });

  it("game-started hands the players to the game and opens the game screen", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    const players = [player("alice", true), player("bob")];
    act(() => mockSocket.fire("game-started", players));
    expect(mockCtx.setPlayersProvider).toHaveBeenCalledWith(players);
    expect(mockReplace).toHaveBeenCalledWith("/screens/GameScreen");
    act(() => r.unmount());
  });

  it("another player removed by the host leaves the list; nothing else happens", async () => {
    const r = await mount([player("alice"), player("bob", true), player("carol")]);
    act(() => mockSocket.fire("player-removed", player("carol")));
    expect(hasId(r, lobbyPlayerId("carol"))).toBe(false);
    expect(hasId(r, lobbyPlayerId("alice"))).toBe(true);
    expect(mockCtx.endSocket).not.toHaveBeenCalled();
    expect(mockDismissTo).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

describe("WaitingRoom: the host's Start answers (EXP-379)", () => {
  const startButton = (r: TestRenderer.ReactTestRenderer) =>
    r.root.find((n) => n.props.testID === TEST_IDS.startGameButton && typeof n.props.onPress === "function");
  const texts = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children as string);
  const noticeText = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => n.props.testID === TEST_IDS.startGameNotice).map((n) => n.props.children)[0];
  /** The ack callback of the last start-game the screen sent */
  const startAck = () => {
    const sent = mockSocket.emitted.filter(([e]) => e === "start-game").pop()!;
    return sent[sent.length - 1] as (answer: unknown) => void;
  };
  /** Plays the server's ack and lets the screen render what it says */
  const answer = async (ack: unknown) => { await act(async () => { startAck()(ack); }); };

  it("shows Starting… and ignores taps until the ack; an accepted start stays so while game-started opens the game", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, TEST_IDS.startGameButton);
    expect(startButton(r).props.disabled).toBe(true);
    expect(texts(r)).toContain("Starting…");
    pressId(r, TEST_IDS.startGameButton);
    expect(emitted("start-game")).toHaveLength(1);
    // The rounds are fixed once Start is pressed: the game starts with what the server has
    const pill = r.root.find((n) => n.props.testID === roundsOptionId(20) && typeof n.props.onPress === "function");
    expect(pill.props.disabled).toBe(true);
    expect(pill.props.accessibilityState).toMatchObject({ disabled: true });

    act(() => mockSocket.fire("game-started", [player("alice", true), player("bob")]));
    await answer({ ok: true });
    expect(mockReplace).toHaveBeenCalledWith("/screens/GameScreen");
    expect(startButton(r).props.disabled).toBe(true);
    expect(hasId(r, TEST_IDS.startGameNotice)).toBe(false);
    act(() => r.unmount());
  });

  it("refused because the only other player was gone: back to waiting, telling the host who left", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, TEST_IDS.startGameButton);
    act(() => mockSocket.fire("player-left", "bob")); // the start removed bob before answering
    await answer({ ok: false, reason: "not-enough-players", removed: ["bob"] });
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);
    expect(noticeText(r)).toBe("bob was disconnected and has left the room.");

    act(() => { jest.advanceTimersByTime(START_NOTICE_MS); });
    expect(hasId(r, TEST_IDS.startGameNotice)).toBe(false);
    act(() => r.unmount());
  });

  it("no answer within the timeout: the button is usable again, with a generic notice", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, TEST_IDS.startGameButton);
    await act(async () => { jest.advanceTimersByTime(START_ACK_TIMEOUT_MS); });
    expect(startButton(r).props.disabled).toBe(false);
    expect(texts(r)).toContain("Start Game");
    const pill = r.root.find((n) => n.props.testID === roundsOptionId(20) && typeof n.props.onPress === "function");
    expect(pill.props.disabled).toBe(false); // the rounds can be changed again
    expect(noticeText(r)).toBe("Couldn't start the game. Try again.");

    pressId(r, TEST_IDS.startGameButton); // a new try clears the notice
    expect(emitted("start-game")).toHaveLength(2);
    expect(hasId(r, TEST_IDS.startGameNotice)).toBe(false);
    act(() => r.unmount());
  });

  it("gone players don't count for the Start button", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    expect(hasId(r, TEST_IDS.lobbyHostHint)).toBe(false);
    act(() => mockSocket.fire("player-connection", { username: "bob", connected: false }));
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    expect(hasId(r, TEST_IDS.lobbyWaiting)).toBe(true);
    expect(hasId(r, TEST_IDS.lobbyHostHint)).toBe(true); // the host is asked to invite more players
    act(() => mockSocket.fire("player-connection", { username: "bob", connected: true }));
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(true);
    act(() => r.unmount());
  });

  it("handed the role by a gone host with nobody else here: host hint, no Start (qa/maestro/lobby-host-drop.yaml)", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    expect(hasId(r, TEST_IDS.lobbyHostHint)).toBe(false); // a guest
    act(() => mockSocket.fire("player-connection", { username: "bob", connected: false }));
    act(() => mockSocket.fire("new-host", player("alice", true)));
    expect(hasId(r, TEST_IDS.lobbyHostHint)).toBe(true);
    expect(hasId(r, TEST_IDS.startGameButton)).toBe(false);
    act(() => r.unmount());
  });
});

describe("WaitingRoom: ways out (EXP-063)", () => {
  it("kicked: forgets the rejoin token, ends the socket and goes home telling why (no leave-room, EXP-045)", async () => {
    const r = await mount([player("bob", true), player("alice")]);
    act(() => mockSocket.fire("player-removed", player("alice")));
    expect(mockCtx.clearRejoinToken).toHaveBeenCalledTimes(1);
    expect(mockCtx.endSocket).toHaveBeenCalledTimes(1);
    expect(mockCtx.setHomeNotice).toHaveBeenCalledWith(KICKED_BY_HOST_MESSAGE);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockCtx.leaveRoom).not.toHaveBeenCalled();
    expect(emitted("leave-room")).toHaveLength(0);
    act(() => r.unmount());
  });

  it("the close button leaves the room (GameContext's leave, EXP-254) and goes home", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    act(() => mockClose.onPress!());
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockCtx.endSocket).not.toHaveBeenCalled(); // the leave closes the socket itself, once acked
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    // A second tap before the screen goes does nothing more
    act(() => mockClose.onPress!());
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("unmounting removes every lobby listener (the game screen attaches its own)", async () => {
    const r = await mount([player("alice", true)]);
    expect(listenerCount()).toBeGreaterThan(0);
    act(() => r.unmount());
    expect(listenerCount()).toBe(0);
  });
});

// ── Listeners of others on the shared socket (EXP-106) ──

describe("WaitingRoom: only its own socket listeners (EXP-106)", () => {
  it("mounting keeps listeners someone else attached before", async () => {
    const other = jest.fn();
    mockSocket.on("room-of-game", other);
    const r = await mount([player("alice", true)]);
    expect(other).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("unmounting after the game screen attached its listeners leaves them working", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    // The game screen's effects may run before the lobby's cleanup in the same commit
    const gameState = jest.fn();
    const connect = jest.fn();
    mockSocket.on("game-state", gameState);
    mockSocket.on("connect", connect);
    act(() => r.unmount());

    expect(listenerCount()).toBe(2);
    mockSocket.fire("game-state", { started: true, players: [] });
    mockSocket.fire("connect");
    expect(gameState).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    // The lobby's own handlers are gone: no rejoin from the lobby, no navigation
    expect(emitted("join-create-game")).toHaveLength(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

// ── Android hardware back (EXP-064) ──

describe("WaitingRoom: Android back with the chat keyboard (EXP-064)", () => {
  const pressBack = (keyboardVisible: boolean) => {
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(keyboardVisible);
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    dismiss.mockClear();
    const consumed = mockBack.handler!();
    return { consumed, dismiss };
  };

  it("the first back press only closes the open keyboard and stays in the room", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    const { consumed, dismiss } = pressBack(true);
    expect(consumed).toBe(true);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(emitted("leave-room")).toHaveLength(0);
    expect(mockDismissTo).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("the second back press, with the keyboard closed, leaves the room (EXP-336)", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressBack(true);
    const { consumed, dismiss } = pressBack(false);
    expect(consumed).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });
});

// ── Android back is Exit (EXP-336) ──

describe("WaitingRoom: Android back leaves the room like the close button (EXP-336)", () => {
  const pressBack = () => {
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
    return mockBack.handler!();
  };

  it("with the keyboard hidden, back sends leave-room (GameContext's leave) and goes home instead of popping", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    // Consumed: the default pop would only close the socket, a lost connection for the server
    expect(pressBack()).toBe(true);
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockCtx.endSocket).not.toHaveBeenCalled(); // the leave closes the socket itself, once acked
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });

  it("leaves only once, however many back presses and close-button taps arrive before the screen goes", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressBack();
    pressBack();
    act(() => mockClose.onPress!());
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("with the host's remove-player confirmation open, back only closes it and stays in the room", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    pressId(r, lobbyPlayerId("bob"));
    expect(mockAlert.visible).toBe(true);

    let consumed!: boolean;
    act(() => { consumed = pressBack(); });
    expect(consumed).toBe(true);
    expect(mockAlert.visible).toBe(false);
    expect(mockCtx.leaveRoom).not.toHaveBeenCalled();
    expect(emitted("remove-player")).toHaveLength(0);
    expect(mockDismissTo).not.toHaveBeenCalled();

    // With the confirmation closed, the next back is Exit
    act(() => { pressBack(); });
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });

  it("back after the close button does not leave again", async () => {
    const r = await mount([player("alice", true), player("bob")]);
    act(() => mockClose.onPress!());
    expect(pressBack()).toBe(true);
    expect(mockCtx.leaveRoom).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});

describe("WaitingRoom: room code (EXP-198)", () => {
  it("shows the room's alphanumeric code in the lobby", async () => {
    const r = await mount([player("alice", true)]);
    expect(r.root.find((n) => n.props.testID === TEST_IDS.lobbyGameCode && typeof n.type === "string").props.children).toBe("K7MQ4X");
    act(() => r.unmount());
  });

  it("takes the invite deep link's code in any case", async () => {
    mockRoute.gameCode = null;
    mockRoute.params = { code: " k7mq4x " };
    const r = await mount();
    await pressInviteJoin(r); // confirmed in the invite dialog (EXP-347)
    expect(mockCtx.setGameCode).toHaveBeenCalledWith("K7MQ4X");
    act(() => r.unmount());
  });

  // EXP-334 pinned this with no room known only; with one known (EXP-367: the code typed or linked before) the link
  // rejoined that room. A malformed code names no room: home in both cases.
  it.each([
    ["no room known", null],
    ["a room known", "K7MQ4X"],
  ])("ignores a malformed deep link code: with %s it goes home, never joining nor creating a room", async (_name, gameCode) => {
    mockRoute.gameCode = gameCode;
    mockRoute.params = { code: "12345O" };
    const r = await mount();
    expect(mockCtx.setGameCode).not.toHaveBeenCalled();
    expect(mockCtx.takeNewRoomRequest).toHaveBeenCalled();
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockCtx.startSocket).not.toHaveBeenCalled();
    expect(emitted("join-create-game")).toEqual([]);
    act(() => r.unmount());
  });
});
