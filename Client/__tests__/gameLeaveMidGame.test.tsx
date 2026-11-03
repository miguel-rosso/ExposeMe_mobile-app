import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { BackHandler } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
import es from "../app/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-377 / DEC-050 A: a game in progress can be left on purpose. An Exit button during the game and in the pause
// modal (and Android back, the same Exit) asks first («Leave the game? You won't be able to rejoin»): Cancel keeps the
// player in the game, Leave sends leave-room (leaveRoom: the server takes it as a real leave, DEC-011) and goes home
// marking the room exit (useGoHome). Before, the only way out was killing the app, which the server took as a lost
// connection (the others paused for up to 5 min).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockDismissTo = jest.fn();
const mockLeaveRoom = jest.fn();
const mockMarkRoomExit = jest.fn();
const mockPlayers = ["alice", "bob"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: mockDismissTo }),
  useLocalSearchParams: () => ({}),
  // Focused for the whole test: the Android back handler is subscribed on mount
  useFocusEffect: (effect: () => void | (() => void)) => require("react").useEffect(effect, []),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    clearRejoinToken: jest.fn(), setPlantedPhotoUri: jest.fn(), setHomeNotice: jest.fn(),
    markRoomExit: mockMarkRoomExit, leaveRoom: mockLeaveRoom,
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
// null: photo access is fine; a status: the game's blocking gallery notice is up
let mockGalleryBlocked: { status: string; limited: boolean; canAskAgain: boolean } | null = null;
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: mockGalleryBlocked, check: jest.fn(), selectMore: jest.fn() }),
}));
let mockT: typeof en | typeof es = en;
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock("react-native-animatable", () => {
  const { View } = require("react-native");
  return { View };
});
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

let backHandlers: (() => boolean | null | undefined)[] = [];
beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const FINAL_SCORE = mockPlayers.map(({ username, points, isHost }) => ({ username, points, isHost, lastAnswerCorrect: false, lastGuess: "" }));
const ROUND_START = { round: 1, totalRounds: 10, photo: "/temp/p.jpg", duration: 8500 };
const PAUSED = { duration: 300_000, waitingFor: ["alice"], pause: 1, maxPauses: 3 };

const find = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const has = (root: ReactTestInstance, id: string) => find(root, id).length > 0;
/** The touchable with that testID (the host component the press goes to) */
const press = (root: ReactTestInstance, id: string) => {
  const target = find(root, id).find((n) => typeof n.props.onPress === "function");
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  act(() => target.props.onPress());
};
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
/** Android back (key or gesture): the newest subscribed handler first, like BackHandler */
const pressBack = () => {
  let consumed: boolean | null | undefined = false;
  act(() => { consumed = [...backHandlers].reverse().find((h) => h()) !== undefined; });
  return consumed;
};

describe("GameScreen: leaving a game in progress (EXP-377)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    mockT = en;
    mockGalleryBlocked = null;
    mockSocket.reset();
    [mockDismissTo, mockLeaveRoom, mockMarkRoomExit].forEach((m) => m.mockClear());
    backHandlers = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation(((_: string, h: () => boolean) => {
      backHandlers.push(h);
      return { remove: () => { backHandlers = backHandlers.filter((x) => x !== h); } };
    }) as typeof BackHandler.addEventListener);
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const expectStillInGame = () => {
    expect(mockLeaveRoom).not.toHaveBeenCalled();
    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(mockSocket.emittedPayloads("leave-room")).toHaveLength(0);
  };
  const expectLeftForGood = () => {
    expect(mockLeaveRoom).toHaveBeenCalledTimes(1);
    expect(mockMarkRoomExit).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledTimes(1);
    expect(mockDismissTo).toHaveBeenCalledWith("/");
    // leaveRoom comes first: home closes a socket still marked as the room's only after the leave was sent
    expect(mockLeaveRoom.mock.invocationCallOrder[0]).toBeLessThan(mockMarkRoomExit.mock.invocationCallOrder[0]);
  };

  it("shows the Exit button in every phase of the game, from the ready phase on", () => {
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(true);
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000, gameNumber: 1 }));
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(true);
    act(() => mockSocket.fire("round-start", ROUND_START));
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(true);
  });

  it("asks first: Cancel keeps me in the game", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    press(r.root, TEST_IDS.leaveGameButton);

    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(true);
    const confirm = find(r.root, TEST_IDS.leaveGameConfirm)[0];
    expect(textOf(confirm)).toContain("Leave the game?");
    expect(textOf(confirm)).toContain("You won't be able to rejoin.");
    expectStillInGame();

    press(r.root, TEST_IDS.alertModalCancel);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(true);
    expectStillInGame();
  });

  it("Leave sends leave-room (leaveRoom) and goes home marking the room exit, once", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    press(r.root, TEST_IDS.leaveGameButton);
    press(r.root, TEST_IDS.alertModalConfirm);

    expectLeftForGood();
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
  });

  it("asks in Spanish with the decided wording", () => {
    mockT = es;
    act(() => r.update(<GameScreen />));
    press(r.root, TEST_IDS.leaveGameButton);
    const confirm = textOf(find(r.root, TEST_IDS.leaveGameConfirm)[0]);
    expect(confirm).toContain("¿Salir de la partida?");
    expect(confirm).toContain("No podrás volver a entrar.");
  });

  it("the pause modal has its own Exit (the game's button is under it), with the same question", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    act(() => mockSocket.fire("game-paused", PAUSED));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(false);

    press(r.root, TEST_IDS.pausedLeaveButton);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(true);
    press(r.root, TEST_IDS.alertModalCancel);
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(true);
    expectStillInGame();

    press(r.root, TEST_IDS.pausedLeaveButton);
    press(r.root, TEST_IDS.alertModalConfirm);
    expectLeftForGood();
  });

  it("Android back is the same Exit: it asks, back again cancels, and it never pops the game", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    expect(pressBack()).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(true);
    expectStillInGame();

    expect(pressBack()).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    expectStillInGame();

    // While paused too
    act(() => mockSocket.fire("game-paused", PAUSED));
    expect(pressBack()).toBe(true);
    press(r.root, TEST_IDS.alertModalConfirm);
    expectLeftForGood();
  });

  it("after game over neither the button nor back asks: the final screens have their own Exit", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    press(r.root, TEST_IDS.leaveGameButton); // the question is open when the game ends
    act(() => mockSocket.fire("game-over", { finalScore: FINAL_SCORE }));

    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(false);
    expect(pressBack()).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    expectStillInGame();
  });

  // The blocking gallery notice covers the game's Exit: on iOS (no back) it would leave no way out at all
  it("the blocking gallery notice has its own Exit, with the same question", () => {
    mockGalleryBlocked = { status: "denied", limited: false, canAskAgain: false };
    act(() => r.update(<GameScreen />));
    act(() => mockSocket.fire("round-start", ROUND_START));
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    const exit = find(r.root, TEST_IDS.galleryBackButton).find((n) => typeof n.props.onPress === "function")!;
    expect(textOf(exit)).toBe("Leave game");

    press(r.root, TEST_IDS.galleryBackButton);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(true);
    press(r.root, TEST_IDS.alertModalCancel);
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    expectStillInGame();

    press(r.root, TEST_IDS.galleryBackButton);
    press(r.root, TEST_IDS.alertModalConfirm);
    expectLeftForGood();
  });

  it("hides the button while the photo owner holds the photo (the game layer is hidden then)", () => {
    act(() => mockSocket.fire("round-start", ROUND_START));
    act(() => mockSocket.fire("hold-start"));
    expect(has(r.root, TEST_IDS.gameHeld)).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameButton)).toBe(false);
  });
});
