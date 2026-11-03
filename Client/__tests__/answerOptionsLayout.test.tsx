import React from "react";
import { AccessibilityInfo, Dimensions, StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { TEST_IDS, playerOptionId } from "../src/utils/testIds";
import {
  ANSWERS_MAX_HEIGHT_RATIO, COMPACT_FROM_PLAYERS, MIN_TOUCH_TARGET, THREE_COLUMNS_FROM_PLAYERS, answerOptionsLayout,
} from "../src/utils/answerOptionsLayout";
import { playerColors } from "../src/utils/playerColors";
import { resetReduceMotionSettingForTests } from "../src/hooks/useReduceMotion";

// EXP-250: with up to 12 players the answer options grew upwards over the photo and the timer bar, and could not
// scroll. They now get denser as the room grows and live in an area capped to a share of the window that scrolls.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const ME = "player1";
const playerNames = (count: number) => Array.from({ length: count }, (_, i) => `player${i + 1}`);
let mockPlayers: ReturnType<typeof makePlayers> = [];
const makePlayers = (names: string[]) => names.map((username) => ({
  username, points: 0, isHost: username === ME, connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
// Stateful players list, like GameContext's useState
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "player1", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider, setPlayersProvider, roundsOfGame: 10, plantedPhotoUri: null,
      plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    };
  },
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

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
// The name label (the only ellipsized text: the avatar's initial comes before it, my "You" tag after it)
const nameText = (option: ReactTestInstance) =>
  option.findAll((n) => (n.type as unknown) === "Text" && n.props.ellipsizeMode !== undefined)[0];
// The nearest native view above a node
const hostParent = (node: ReactTestInstance) => {
  let n = node.parent;
  while (n && typeof n.type !== "string") n = n.parent;
  return n!;
};
// The grid cell around an option's card: its width and the gap below it
const cellOf = hostParent;
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
  act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }));
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
    for (const name of names) expect(pressable(r.root, name).props.accessibilityState.disabled).toBe(false);
    for (const o of opts) {
      expect(touchHeight(o)).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(styleOf(cellOf(o)).flexBasis).toBe("30%");
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
      expect(styleOf(o)).toMatchObject({ paddingTop: 12, paddingBottom: 12, paddingLeft: 12 });
      expect(styleOf(cellOf(o))).toMatchObject({ marginBottom: 8, flexBasis: "48%" });
      expect(styleOf(nameText(o)).fontSize).toBe(16);
      expect(nameText(o).props.ellipsizeMode).toBe("tail");
    }
    act(() => r.unmount());
  });

  // A player who leaves mid-round stays an option until the next photo wait (DEC-038): the grid re-lays out then
  it("re-lays out without crashing when players leave (3 columns back to 2 in the next round)", async () => {
    const leaver = playerOptionId(`player${THREE_COLUMNS_FROM_PLAYERS}`);
    const r = await renderAnswering(playerNames(THREE_COLUMNS_FROM_PLAYERS));
    expect(styleOf(cellOf(host(r.root, playerOptionId("player2")))).flexBasis).toBe("30%");
    act(() => mockSocket.fire("player-left", `player${THREE_COLUMNS_FROM_PLAYERS}`));
    expect(styleOf(cellOf(host(r.root, playerOptionId("player2")))).flexBasis).toBe("30%");
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 2, duration: 8_000 }));
    expect(styleOf(cellOf(host(r.root, playerOptionId("player2")))).flexBasis).toBe("48%");
    expect(r.root.findAll((n) => n.props.testID === leaver)).toHaveLength(0);
    act(() => r.unmount());
  });
});

// EXP-253: the cards got the players' colours, equal widths and an entrance that honours "reduce motion"
describe("GameScreen answer cards (EXP-253)", () => {
  // Smallest phone height the cards are checked on (iPhone SE class)
  const SMALL_WINDOW_HEIGHT = 667;
  // The avatar: the first native view in the card's row, before the name
  const avatarOf = (option: ReactTestInstance) => hostParent(nameText(option)).findAll((n) => typeof n.type === "string")[1];
  const optionHosts = (node: ReactTestInstance) =>
    node.findAll((n) => typeof n.type === "string" && typeof n.props.testID === "string" && n.props.testID.startsWith("player-option-"));

  // The reduce-motion setting is cached for the app's lifetime: each test asks the system again
  beforeEach(() => { jest.useFakeTimers(); resetReduceMotionSettingForTests(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  it("with an odd count the last card keeps the others' width and is centred in its row", async () => {
    const names = playerNames(3);
    const r = await renderAnswering(names);
    const cells = options(r.root, names).map(cellOf);
    for (const c of cells) {
      expect(styleOf(c).flexBasis).toBe("48%");
      expect(styleOf(c).flexGrow ?? 0).toBe(0);
    }
    const lastRow = hostParent(cells[2]);
    expect(optionHosts(lastRow)).toHaveLength(1);
    expect(styleOf(lastRow).justifyContent).toBe("center");
    act(() => r.unmount());
  });

  it("draws each player with the room's colour for their name", async () => {
    const names = ["alice", "bob", "carol", "dave"];
    const colors = playerColors(names);
    const r = await renderAnswering(names);
    for (const name of names) expect(styleOf(avatarOf(host(r.root, playerOptionId(name)))).backgroundColor).toBe(colors.get(name));
    act(() => r.unmount());
  });

  it("12 compact cards fit in the options area of a small phone without scrolling", async () => {
    const names = playerNames(12);
    const r = await renderAnswering(names);
    const { columns, maxHeight } = answerOptionsLayout(names.length, SMALL_WINDOW_HEIGHT);
    const option = host(r.root, playerOptionId("player2"));
    const card = styleOf(option);
    const rowHeight = card.paddingTop + card.paddingBottom + 2 * card.borderWidth
      + Math.max(styleOf(nameText(option)).lineHeight, styleOf(avatarOf(option)).height)
      + styleOf(cellOf(option)).marginBottom;
    const listTopPadding = StyleSheet.flatten(answersList(r.root).props.contentContainerStyle)?.paddingTop ?? 0;
    expect(listTopPadding + Math.ceil(names.length / columns) * rowHeight).toBeLessThanOrEqual(maxHeight);
    act(() => r.unmount());
  });

  it("the cards fade in when voting starts, and appear at once with reduce motion on", async () => {
    let r = await renderAnswering(playerNames(4));
    expect(styleOf(cellOf(host(r.root, playerOptionId("player2")))).opacity).toBe(0);
    act(() => r.unmount());

    // A cold app whose system asks to reduce motion (the setting outlives the first screen otherwise)
    resetReduceMotionSettingForTests();
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    r = await renderAnswering(playerNames(4));
    for (const o of options(r.root, playerNames(4))) expect(styleOf(cellOf(o)).opacity).toBe(1);
    act(() => r.unmount());
  });
});
