import React from "react";
import { Dimensions, StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { TEST_IDS, playerOptionId } from "../app/utils/testIds";
import {
  ANSWERS_MAX_HEIGHT_RATIO, COMPACT_FROM_PLAYERS, MIN_TOUCH_TARGET, THREE_COLUMNS_FROM_PLAYERS, answerOptionsLayout,
} from "../app/utils/answerOptionsLayout";

// EXP-250: with up to 12 players the answer options grew upwards over the photo and the timer bar, and could not
// scroll. They now get denser as the room grows and live in an area capped to a share of the window that scrolls.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  connect = jest.fn(() => this);
  disconnect = jest.fn(() => this);
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn?: Handler) {
    if (fn) this.handlers.get(ev)?.delete(fn);
    else this.handlers.delete(ev);
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
}

const mockSocket = new FakeSocket();
const ME = "player1";
const playerNames = (count: number) => Array.from({ length: count }, (_, i) => `player${i + 1}`);
let mockPlayers: ReturnType<typeof makePlayers> = [];
const makePlayers = (names: string[]) => names.map((username) => ({
  username, points: 0, isHost: username === ME, connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
// Stateful players list, like GameContext's useState
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "player1", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider, setPlayersProvider, roundsOfGame: 10, plantedPhotoUri: null,
      plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    };
  },
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const host = (root: ReactTestInstance, id: string) => root.find((n) => n.props.testID === id && typeof n.type === "string");
const options = (root: ReactTestInstance, names: string[]) => names.map((name) => host(root, playerOptionId(name)));
// The TouchableOpacity itself (its onPress and disabled props)
const pressable = (root: ReactTestInstance, name: string) =>
  root.find((n) => n.props.testID === playerOptionId(name) && typeof n.props.onPress === "function");
const answersList = (root: ReactTestInstance) => host(root, TEST_IDS.answerOptions);
const styleOf = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
// The name label (my own option also has the "You" tag after it)
const nameText = (option: ReactTestInstance) => option.findAll((n) => (n.type as unknown) === "Text")[0];
// Option height without the gap below it: vertical padding plus the name's line
const touchHeight = (option: ReactTestInstance) => {
  const card = styleOf(option);
  return card.paddingTop + card.paddingBottom + styleOf(nameText(option)).lineHeight;
};

const renderAnswering = async (names: string[]) => {
  mockPlayers = makePlayers(names);
  mockSocket.emitted = [];
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000, isOwner: false }));
  return r;
};

describe("answerOptionsLayout (EXP-250)", () => {
  it("keeps 2 regular columns in small rooms", () => {
    expect(answerOptionsLayout(4, 800)).toEqual({ columns: 2, compact: false, maxHeight: 320 });
    expect(answerOptionsLayout(COMPACT_FROM_PLAYERS - 1, 800).compact).toBe(false);
  });

  it("compacts the cards, then adds a third column, as the room grows", () => {
    expect(answerOptionsLayout(COMPACT_FROM_PLAYERS, 800)).toMatchObject({ columns: 2, compact: true });
    expect(answerOptionsLayout(THREE_COLUMNS_FROM_PLAYERS - 1, 800).columns).toBe(2);
    expect(answerOptionsLayout(THREE_COLUMNS_FROM_PLAYERS, 800)).toMatchObject({ columns: 3, compact: true });
    expect(answerOptionsLayout(12, 800)).toMatchObject({ columns: 3, compact: true });
  });

  it("caps the options to a share of the window height", () => {
    expect(answerOptionsLayout(12, 667).maxHeight).toBe(Math.round(667 * ANSWERS_MAX_HEIGHT_RATIO));
  });
});

describe("GameScreen answer options (EXP-250)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("with 12 players: bounded scrolling list, 3 columns, every option rendered and pressable", async () => {
    // Two 15-character names (the username cap) sharing a long prefix, last in the list
    const twins = ["Mariacarmen_001", "Mariacarmen_002"];
    const names = [...playerNames(10), ...twins];
    const r = await renderAnswering(names);
    const list = answersList(r.root);
    expect((list.type as unknown)).toBe("RCTScrollView");
    expect(styleOf(list).maxHeight).toBe(Math.round(Dimensions.get("window").height * ANSWERS_MAX_HEIGHT_RATIO));
    expect(list.props.scrollEnabled).not.toBe(false);
    expect(list.props.showsVerticalScrollIndicator).toBe(true);

    const opts = options(r.root, names);
    expect(opts).toHaveLength(12);
    for (const name of names) expect(pressable(r.root, name).props.disabled).toBe(false);
    for (const o of opts) {
      expect(touchHeight(o)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(styleOf(o).flexBasis).toBe("30%");
      // Cut in the middle: the end of the name stays, so the twins don't both read "Mariacarmen_…"
      expect(nameText(o).props.ellipsizeMode).toBe("middle");
    }
    expect(twins.map((name) => nameText(host(r.root, playerOptionId(name))).props.children)).toEqual(twins);
    // The last option counts like any other
    act(() => pressable(r.root, twins[1]).props.onPress());
    expect(mockSocket.emitted).toContainEqual(["submit-answer", { guess: twins[1] }]);
    act(() => r.unmount());
  });

  it("with 4 players: the regular 2-column cards", async () => {
    const r = await renderAnswering(playerNames(4));
    for (const o of options(r.root, playerNames(4))) {
      expect(styleOf(o)).toMatchObject({ paddingTop: 12, paddingBottom: 12, paddingLeft: 12, marginBottom: 8, flexBasis: "48%" });
      expect(styleOf(nameText(o)).fontSize).toBe(16);
      expect(nameText(o).props.ellipsizeMode).toBe("tail");
    }
    act(() => r.unmount());
  });

  it("re-lays out without crashing when players leave mid-round (3 columns back to 2)", async () => {
    const r = await renderAnswering(playerNames(THREE_COLUMNS_FROM_PLAYERS));
    expect(styleOf(host(r.root, playerOptionId("player2"))).flexBasis).toBe("30%");
    act(() => mockSocket.fire("player-left", `player${THREE_COLUMNS_FROM_PLAYERS}`));
    expect(styleOf(host(r.root, playerOptionId("player2"))).flexBasis).toBe("48%");
    expect(r.root.findAll((n) => n.props.testID === playerOptionId(`player${THREE_COLUMNS_FROM_PLAYERS}`))).toHaveLength(0);
    act(() => r.unmount());
  });
});
