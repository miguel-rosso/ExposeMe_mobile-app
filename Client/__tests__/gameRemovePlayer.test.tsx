import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { BackHandler } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import { Player } from "../src/models/interfaces";
import { TEST_IDS, pausedRemoveId, scoreRemoveId } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-425 / DEC-052 A: the host can remove a player during the game, from the round's scoreboard (a remove button on
// every other player's row) and from the pause modal (one per awaited player), with the lobby's question naming the
// player. Remove sends remove-player; Cancel (or Android back) keeps them. Nobody else gets those buttons.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const player = (username: string): Player => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
});
const ROOM = ["alice", "bob", "carol"].map(player);
// The room as the game screen last set it (player-left / player-removed drop players from it)
let mockPlayers: Player[] = ROOM;
let mockUsername = "alice";
let mockT: typeof en | typeof es = en;
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({}),
  // Focused for the whole test: the Android back handler is subscribed on mount
  useFocusEffect: (effect: () => void | (() => void)) => require("react").useEffect(effect, []),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: mockUsername, gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: (next: Player[]) => { mockPlayers = next; },
    roundsOfGame: 10, plantedPhotoUri: null, plantedPhotoSent: false, plantPhoto: jest.fn(),
    getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(), clearRejoinToken: jest.fn(),
    setPlantedPhotoUri: jest.fn(), setHomeNotice: jest.fn(), markRoomExit: jest.fn(), leaveRoom: jest.fn(),
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock("react-native-animatable", () => {
  const { View } = require("react-native");
  return { View };
});
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

let backHandlers: (() => boolean | null | undefined)[] = [];
beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());

const ROUND_START = { round: 1, photo: "/temp/p.jpg", duration: 7_700 };
const scoreRow = (username: string) => ({ username, points: 0, isHost: username === "alice", lastGuess: "", lastAnswerCorrect: false });
const ROUND_SCORES = { round: 1, totalRounds: 10, duration: 5_000, scores: ROOM.map((p) => scoreRow(p.username)) };
const PAUSED = { duration: 300_000, waitingFor: ["bob", "carol"], pause: 1, maxPauses: 3 };

const find = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const has = (root: ReactTestInstance, id: string) => find(root, id).length > 0;
/** The innermost touchable with that testID (the one the press goes to, not a component passing the id down) */
const pressable = (root: ReactTestInstance, id: string) => {
  const target = find(root, id).filter((n) => typeof n.props.onPress === "function").pop();
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  return target;
};
const press = (root: ReactTestInstance, id: string) => act(() => pressable(root, id).props.onPress());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const kicks = () => mockSocket.emittedPayloads("remove-player");

describe("GameScreen: the host removes a player during the game (EXP-425)", () => {
  let r: TestRenderer.ReactTestRenderer;
  const mount = async () => {
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("round-start", ROUND_START));
  };
  /** Re-render with the room the screen last set (the context's state update) */
  const rerender = () => act(() => r.update(<GameScreen />));

  beforeEach(() => {
    jest.useFakeTimers();
    mockT = en;
    mockUsername = "alice";
    mockPlayers = ROOM;
    mockSocket.reset();
    backHandlers = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation(((_: string, h: () => boolean) => {
      backHandlers.push(h);
      return { remove: () => { backHandlers = backHandlers.filter((x) => x !== h); } };
    }) as typeof BackHandler.addEventListener);
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("the scoreboard has a remove button on every other player's row, named for screen readers", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));

    expect(has(r.root, scoreRemoveId("alice"))).toBe(false);
    for (const name of ["bob", "carol"]) {
      expect(pressable(r.root, scoreRemoveId(name)).props.accessibilityLabel).toBe(`Remove ${name}`);
    }
  });

  it("asks first naming the player: Cancel keeps them, Remove sends remove-player once", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    press(r.root, scoreRemoveId("bob"));

    const question = find(r.root, TEST_IDS.removePlayerConfirm)[0];
    expect(textOf(question)).toContain("Remove player");
    expect(textOf(question)).toContain("Are you sure you want to remove @bob from the room?");
    expect(kicks()).toEqual([]);
    press(r.root, TEST_IDS.alertModalCancel);
    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(false);
    expect(kicks()).toEqual([]);

    press(r.root, scoreRemoveId("bob"));
    press(r.root, TEST_IDS.alertModalConfirm);
    expect(kicks()).toEqual([{ username: "bob" }]);
    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(false);
  });

  it("asks in Spanish too", async () => {
    mockT = es;
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    expect(pressable(r.root, scoreRemoveId("carol")).props.accessibilityLabel).toBe("Expulsar a carol");
    press(r.root, scoreRemoveId("carol"));
    const question = textOf(find(r.root, TEST_IDS.removePlayerConfirm)[0]);
    expect(question).toContain("Expulsar jugador");
    expect(question).toContain("¿Seguro que quieres expulsar a @carol de la sala?");
  });

  it("the question outlives the scoreboard, and closes on its own once that player is out of the room", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    press(r.root, scoreRemoveId("carol"));
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000, gameNumber: 1 }));
    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(true);

    act(() => mockSocket.fire("player-left", "carol"));
    rerender();
    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(false);
  });

  it("a player kicked during the scoreboard loses their remove button (the row stays until the next scoreboard)", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    expect(has(r.root, scoreRemoveId("bob"))).toBe(true);

    act(() => mockSocket.fire("player-removed", ROOM[1]));
    rerender();

    expect(has(r.root, TEST_IDS.scoreModal)).toBe(true);
    expect(has(r.root, scoreRemoveId("bob"))).toBe(false);
    expect(has(r.root, scoreRemoveId("carol"))).toBe(true);
  });

  it("game over closes the question on the scoreboard: nothing is removed", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    press(r.root, scoreRemoveId("bob"));
    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(true);

    act(() => mockSocket.fire("game-over", { finalScore: ROUND_SCORES.scores }));

    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(false);
    expect(has(r.root, TEST_IDS.alertModalConfirm)).toBe(false);
    expect(kicks()).toEqual([]);
  });

  it("the pause modal lists the awaited players to remove, with the same question", async () => {
    await mount();
    act(() => mockSocket.fire("game-paused", PAUSED));

    expect(pressable(r.root, pausedRemoveId("bob")).props.accessibilityLabel).toBe("Remove bob");
    press(r.root, pausedRemoveId("carol"));
    expect(textOf(find(r.root, TEST_IDS.removePlayerConfirm)[0])).toContain("@carol");
    press(r.root, TEST_IDS.alertModalConfirm);
    expect(kicks()).toEqual([{ username: "carol" }]);
  });

  it("Android back closes the question, and doesn't ask to leave the game", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    press(r.root, scoreRemoveId("bob"));

    act(() => { [...backHandlers].reverse().find((h) => h()); });

    expect(has(r.root, TEST_IDS.removePlayerConfirm)).toBe(false);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    expect(kicks()).toEqual([]);
  });

  it("other players get no remove buttons", async () => {
    mockUsername = "bob";
    await mount();
    act(() => mockSocket.fire("round-scores", ROUND_SCORES));
    for (const name of ["alice", "carol"]) expect(has(r.root, scoreRemoveId(name))).toBe(false);
    act(() => mockSocket.fire("game-paused", { ...PAUSED, waitingFor: ["carol"] }));
    expect(has(r.root, pausedRemoveId("carol"))).toBe(false);
  });
});
