import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { Player } from "../src/models/interfaces";
import { TEST_IDS, pausedMuteId, playerOptionId, scoreMuteId, scoreRankId } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-422 / DEC-052 A: in the game, any player can mute another one from the scoreboard's rows and the pause modal.
// A muted player's emoji reactions (the screenshot one included) are hidden, those on screen too. Their round photo is
// never covered (DEC-063: everyone sees it while answering, so covering it at the reveal protects nobody). They stay an
// answer option and keep their points.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const player = (username: string): Player => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
});
const ROOM = ["alice", "bob", "carol"].map(player);
let mockPlayers: Player[] = ROOM;
// A room code per test: mutes last for the room, so every test starts with nobody muted
let mockGameCode = "MUTE00";
let mockT: typeof en | typeof es = en;
// Times the game screen rendered: it draws the (mocked) photo on every render while a photo is shown
const mockScreenRenders = { count: 0 };
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "alice", gameCode: mockGameCode, socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: (next: Player[]) => { mockPlayers = next; },
    roundsOfGame: 10, plantedPhotoUri: null, plantedPhotoSent: false, plantPhoto: jest.fn(),
    getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(), clearRejoinToken: jest.fn(),
    setPlantedPhotoUri: jest.fn(), leaveRoom: jest.fn(),
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
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@/src/components/PhotoComponent", () => () => { mockScreenRenders.count++; return null; });
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);
// A reaction pill on screen, by its sender and emoji
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => (props: { username: string; emoji: string }) =>
  require("react").createElement("ReactionPill", { username: props.username, emoji: props.emoji }));

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const roundStart = (round: number) => ({ round, photo: `/temp/${round}.jpg`, duration: 7_700 });
const scoreRow = (username: string, points: number) =>
  ({ username, points, isHost: username === "alice", lastGuess: "", lastAnswerCorrect: false });
const roundScores = (round: number) => ({
  round, totalRounds: 10, duration: 5_000, scores: [scoreRow("alice", 0), scoreRow("bob", 300), scoreRow("carol", 100)],
});
const reveal = (owner: string) => ({ correctAnswer: owner, duration: 3_000, yourGuess: "" });

const find = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const has = (root: ReactTestInstance, id: string) => find(root, id).length > 0;
/** Every testID on screen, once each, sorted */
const screenIds = (root: ReactTestInstance) =>
  [...new Set(root.findAll((n) => typeof n.props.testID === "string").map((n) => n.props.testID as string))].sort();
/** The innermost touchable with that testID (the one the press goes to) */
const pressable = (root: ReactTestInstance, id: string) => {
  const target = find(root, id).filter((n) => typeof n.props.onPress === "function").pop();
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  return target;
};
const press = (root: ReactTestInstance, id: string) => act(() => pressable(root, id).props.onPress());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const pills = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "ReactionPill").map((n) => `${n.props.username} ${n.props.emoji}`);
// Arrivals are shown on the next frame
const FRAME_MS = 16;
const nextFrame = () => act(() => { jest.advanceTimersByTime(FRAME_MS); });
const react = (username: string, emoji: string) => act(() => mockSocket.fire("emoji-reaction", { username, emoji }));

describe("GameScreen: muting a player (EXP-422)", () => {
  let r: TestRenderer.ReactTestRenderer;
  let testNumber = 0;
  const mount = async () => {
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("round-start", roundStart(1)));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockT = en;
    mockPlayers = ROOM;
    mockGameCode = `MUTE${++testNumber}`;
    mockSocket.reset();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("the scoreboard has a mute button on every other player's row, named for screen readers (en/es)", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    expect(has(r.root, scoreMuteId("alice"))).toBe(false);
    expect(pressable(r.root, scoreMuteId("bob")).props.accessibilityLabel).toBe("Mute bob");
    press(r.root, scoreMuteId("bob"));
    expect(pressable(r.root, scoreMuteId("bob")).props.accessibilityLabel).toBe("Unmute bob");
    expect(pressable(r.root, scoreMuteId("bob")).findByType("Icon" as never).props.name).toBe("volume-off");
    expect(pressable(r.root, scoreMuteId("carol")).findByType("Icon" as never).props.name).toBe("volume-up");
    act(() => r.unmount());

    mockT = es;
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    expect(pressable(r.root, scoreMuteId("bob")).props.accessibilityLabel).toBe("Quitar silencio a bob");
    expect(pressable(r.root, scoreMuteId("carol")).props.accessibilityLabel).toBe("Silenciar a carol");
  });

  it("hides a muted player's reactions, those on screen and the screenshot one too; unmuting shows their next ones", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    react("bob", "😂");
    react("carol", "🔥");
    nextFrame();
    expect(pills(r)).toEqual(["carol 🔥", "bob 😂"]); // newest first

    press(r.root, scoreMuteId("bob"));
    expect(pills(r)).toEqual(["carol 🔥"]);
    react("bob", "😍");
    react("bob", "📸");
    react("carol", "😭");
    nextFrame();
    expect(pills(r)).toEqual(["carol 😭", "carol 🔥"]);

    press(r.root, scoreMuteId("bob"));
    react("bob", "🤡");
    nextFrame();
    expect(pills(r)).toEqual(["bob 🤡", "carol 😭", "carol 🔥"]);
  });

  it("a mute queued in the same frame as a muted player's reactions drops them too", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    react("bob", "😂");
    press(r.root, scoreMuteId("bob"));
    nextFrame();
    expect(pills(r)).toEqual([]);
  });

  it("with a player muted, reactions still never re-render the game screen (EXP-393)", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    press(r.root, scoreMuteId("bob"));
    const before = mockScreenRenders.count;
    for (let i = 0; i < 5; i++) {
      react("carol", "🔥");
      react("bob", "😂");
      nextFrame();
    }
    expect(mockScreenRenders.count).toBe(before);
    expect(pills(r)).toHaveLength(5);
  });

  it("a muted player stays an answer option and keeps their place and points on the scoreboard", async () => {
    await mount();
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    press(r.root, scoreMuteId("bob"));

    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000, gameNumber: 1 }));
    act(() => mockSocket.fire("round-start", roundStart(2)));
    for (const name of ["alice", "bob", "carol"]) expect(has(r.root, playerOptionId(name))).toBe(true);
    act(() => pressable(r.root, playerOptionId("bob")).props.onPress());
    act(() => mockSocket.fire("round-scores", roundScores(2)));
    expect(textOf(find(r.root, scoreRankId("bob"))[0])).toBe("1");
    expect(textOf(find(r.root, TEST_IDS.scoreList)[0])).toContain("bob");
    expect(textOf(find(r.root, TEST_IDS.scoreList)[0])).toContain("300");
  });

  it("leaves a muted player's revealed photo on screen as anyone's: nothing covers it, held or not (DEC-063)", async () => {
    await mount();
    // bob's round before he is muted, then after: the screen reads the same from the reveal to the hold
    const screenOfBobsRound = (round: number) => {
      act(() => mockSocket.fire("waiting-photo", { round, duration: 15_000, gameNumber: 1 }));
      act(() => mockSocket.fire("round-start", roundStart(round)));
      act(() => mockSocket.fire("round-reveal", reveal("bob")));
      const revealed = screenIds(r.root);
      act(() => mockSocket.fire("round-scores", roundScores(round)));
      const scoreboard = screenIds(r.root);
      act(() => mockSocket.fire("hold-start"));
      const held = screenIds(r.root);
      act(() => mockSocket.fire("hold-end", { holdsLeft: 1 }));
      return { revealed, scoreboard, held };
    };

    const beforeMute = screenOfBobsRound(2);
    press(r.root, scoreMuteId("bob"));
    const afterMute = screenOfBobsRound(3);

    expect(afterMute).toEqual(beforeMute);
    expect(afterMute.held).toContain(TEST_IDS.gameHeld);
    expect(pressable(r.root, scoreMuteId("bob")).props.accessibilityLabel).toBe("Unmute bob");
  });

  it("the pause modal lets anyone mute an awaited player", async () => {
    await mount();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    const carol = () => pressable(r.root, pausedMuteId("carol"));
    expect(carol().props.accessibilityLabel).toBe("Mute carol");
    expect(textOf(carol())).toContain("carol");
    act(() => carol().props.onPress());
    expect(carol().props.accessibilityLabel).toBe("Unmute carol");
  });
});
