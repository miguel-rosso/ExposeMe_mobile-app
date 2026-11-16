import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { BackHandler } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import { Player } from "../src/models/interfaces";
import { reportReasonId, scoreMuteId, TEST_IDS } from "../src/utils/testIds";
import { REPORT_ACK_TIMEOUT_MS, REPORT_REASONS } from "../src/utils/contentReport";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-423 / DEC-052 A: «Report» on the round photo. Available while the photo is on screen (answering, reveal,
// scoreboard), never on the photo revealed as mine; a reason picker, then report-content with the round and reason
// (nothing else: the server takes reporter and room from the session), «Thanks, we'll review it» once acked. Picking
// the reason also mutes the photo's owner for me (EXP-438) when this device knows who it is (from the reveal on).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const player = (username: string): Player => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
});
let mockPlayers: Player[] = ["alice", "bob", "carol"].map(player);
// A room code per test: mutes last for the room, so every test starts with nobody muted
let mockGameCode = "REPORT0";
let mockT: typeof en | typeof es = en;
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void | (() => void)) => require("react").useEffect(effect, []),
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
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const roundStart = (round: number) => ({ round, photo: `/temp/${round}.jpg`, duration: 7_700 });
const reveal = (owner: string) => ({ correctAnswer: owner, duration: 3_000, yourGuess: "" });
const scoreRow = (username: string) => ({ username, points: 0, isHost: username === "alice", lastGuess: "", lastAnswerCorrect: false });
const roundScores = (round: number) => ({
  round, totalRounds: 10, duration: 5_000, scores: ["alice", "bob", "carol"].map(scoreRow),
});

const find = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const has = (root: ReactTestInstance, id: string) => find(root, id).length > 0;
const pressable = (root: ReactTestInstance, id: string) => {
  const target = find(root, id).filter((n) => typeof n.props.onPress === "function").pop();
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  return target;
};
const press = (root: ReactTestInstance, id: string) => act(() => pressable(root, id).props.onPress());
/** A scoreboard row's mute button, by its screen reader name: "Mute <name>" or, once muted, "Unmute <name>" */
const muteLabelOf = (root: ReactTestInstance, username: string): string =>
  pressable(root, scoreMuteId(username)).props.accessibilityLabel;
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");

/** The report-content emits so far: payload and ack callback */
const reports = () => mockSocket.emitted
  .filter(([event]) => event === "report-content")
  .map(([, payload, ack]) => ({ payload, ack: ack as (answer: unknown) => void }));
/** The server answers the last report */
const answerLastReport = async (answer: unknown) => {
  const last = reports().pop()!;
  await act(async () => { last.ack(answer); });
};

describe("GameScreen: reporting the round photo (EXP-423)", () => {
  let r: TestRenderer.ReactTestRenderer;
  let testNumber = 0;
  const mount = async () => {
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("round-start", roundStart(1)));
  };

  // The screen's Android back handlers, captured so a test can press back
  let backHandlers: (() => boolean)[] = [];
  beforeEach(() => {
    backHandlers = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation(((_: string, h: () => boolean) => {
      backHandlers.push(h);
      return { remove: () => { backHandlers = backHandlers.filter((x) => x !== h); } };
    }) as typeof BackHandler.addEventListener);
    jest.useFakeTimers();
    mockT = en;
    mockPlayers = ["alice", "bob", "carol"].map(player);
    mockGameCode = `REPORT${++testNumber}`;
    mockSocket.reset();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("is offered on the photo while answering, named for screen readers, and not while a photo is awaited", async () => {
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000, gameNumber: 1 }));
    expect(has(r.root, TEST_IDS.reportPhotoButton)).toBe(false);
    act(() => mockSocket.fire("round-start", roundStart(1)));
    expect(pressable(r.root, TEST_IDS.reportPhotoButton).props.accessibilityLabel).toBe("Report photo");
  });

  it("asks why, sends the round and reason only, then thanks once acked (nobody muted: the owner is still secret)", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    expect(textOf(find(r.root, TEST_IDS.reportModal)[0])).toContain("Why are you reporting this?");
    expect(REPORT_REASONS.map((reason) => textOf(pressable(r.root, reportReasonId(reason)))))
      .toEqual(["Sexual content", "Violence or hate", "Harassment", "Other"]);
    expect(reports()).toEqual([]);

    press(r.root, reportReasonId("violence"));
    expect(reports().map((x) => x.payload)).toEqual([{ kind: "photo", round: 1, reason: "violence" }]);
    expect(has(r.root, TEST_IDS.reportSending)).toBe(true);

    await answerLastReport({ ok: true });
    expect(textOf(find(r.root, TEST_IDS.reportThanks)[0])).toBe("Thanks, we'll review it");
    expect(has(r.root, TEST_IDS.reportMutedNotice)).toBe(false);
    press(r.root, TEST_IDS.reportCloseButton);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
  });

  it("Cancel closes the picker without reporting", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    press(r.root, TEST_IDS.reportCancelButton);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
    expect(reports()).toEqual([]);
  });

  it("once revealed, picking the reason mutes the photo's owner, and the thanks says so", async () => {
    await mount();
    act(() => mockSocket.fire("round-reveal", reveal("bob")));
    press(r.root, TEST_IDS.reportPhotoButton);
    press(r.root, reportReasonId("sexual"));

    await answerLastReport({ ok: true });
    expect(textOf(find(r.root, TEST_IDS.reportMutedNotice)[0])).toBe("You muted bob");
    press(r.root, TEST_IDS.reportCloseButton);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    expect(muteLabelOf(r.root, "bob")).toBe("Unmute bob");
    expect(muteLabelOf(r.root, "carol")).toBe("Mute carol");
  });

  it("opened while answering, the reveal coming before the reason: picking it mutes the owner revealed meanwhile", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    act(() => mockSocket.fire("round-reveal", reveal("bob")));
    press(r.root, reportReasonId("sexual"));
    expect(reports().map((x) => x.payload)).toEqual([{ kind: "photo", round: 1, reason: "sexual" }]);
    await answerLastReport({ ok: true });
    expect(textOf(find(r.root, TEST_IDS.reportMutedNotice)[0])).toBe("You muted bob");
    press(r.root, TEST_IDS.reportCloseButton);
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    expect(muteLabelOf(r.root, "bob")).toBe("Unmute bob");
  });

  it("opened while answering, the photo then revealed as mine: picking the reason mutes nobody", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    act(() => mockSocket.fire("round-reveal", reveal("alice")));
    press(r.root, reportReasonId("other"));
    await answerLastReport({ ok: false, reason: "not-found" });
    expect(has(r.root, TEST_IDS.reportRefused)).toBe(true);
    expect(has(r.root, TEST_IDS.reportMutedNotice)).toBe(false);
  });

  it("is offered on the scoreboard too, and never on the photo revealed as mine", async () => {
    await mount();
    act(() => mockSocket.fire("round-reveal", reveal("bob")));
    act(() => mockSocket.fire("round-scores", roundScores(1)));
    expect(has(r.root, TEST_IDS.scoreModal)).toBe(true);
    expect(has(r.root, TEST_IDS.reportPhotoButton)).toBe(true);

    act(() => mockSocket.fire("round-start", roundStart(2)));
    act(() => mockSocket.fire("round-reveal", reveal("alice")));
    expect(has(r.root, TEST_IDS.reportPhotoButton)).toBe(false);
  });

  it("refused for good (e.g. my own photo while answering): says so, with no Try again", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    press(r.root, reportReasonId("harassment"));
    await answerLastReport({ ok: false, reason: "not-found" });
    expect(textOf(find(r.root, TEST_IDS.reportRefused)[0])).toBe("This can't be reported.");
    expect(has(r.root, TEST_IDS.reportRetryButton)).toBe(false);
    expect(has(r.root, TEST_IDS.reportFailed)).toBe(false);
    press(r.root, TEST_IDS.reportCloseButton);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
  });

  it("no answer: says it couldn't be sent, and Try again sends it again", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    press(r.root, reportReasonId("harassment"));
    await act(async () => { jest.advanceTimersByTime(REPORT_ACK_TIMEOUT_MS); });
    expect(textOf(find(r.root, TEST_IDS.reportFailed)[0])).toBe("The report couldn't be sent.");

    press(r.root, TEST_IDS.reportRetryButton);
    expect(reports().map((x) => x.payload)).toEqual([
      { kind: "photo", round: 1, reason: "harassment" }, { kind: "photo", round: 1, reason: "harassment" },
    ]);
    await answerLastReport({ ok: false, reason: "not-in-room" }); // rejoining: may work once back
    expect(has(r.root, TEST_IDS.reportFailed)).toBe(true);
    // An ack that comes after the dialog was closed changes nothing
    press(r.root, TEST_IDS.reportRetryButton);
    await act(async () => { jest.advanceTimersByTime(REPORT_ACK_TIMEOUT_MS); });
    press(r.root, TEST_IDS.reportCloseButton);
    await answerLastReport({ ok: true });
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
  });

  it("Android back closes the report dialog, never asks to leave", async () => {
    await mount();
    press(r.root, TEST_IDS.reportPhotoButton);
    let consumed = false;
    act(() => { consumed = backHandlers.every((h) => h()); });
    expect(consumed).toBe(true);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    // With no dialog open, back is the game's Exit again
    act(() => { backHandlers.forEach((h) => h()); });
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(true);
  });

  it("in Spanish: «Contenido sexual / Violencia o odio / Acoso / Otro», then «Gracias, lo revisaremos»", async () => {
    mockT = es;
    await mount();
    expect(pressable(r.root, TEST_IDS.reportPhotoButton).props.accessibilityLabel).toBe("Denunciar foto");
    press(r.root, TEST_IDS.reportPhotoButton);
    expect(REPORT_REASONS.map((reason) => textOf(pressable(r.root, reportReasonId(reason)))))
      .toEqual(["Contenido sexual", "Violencia o odio", "Acoso", "Otro"]);
    press(r.root, reportReasonId("other"));
    await answerLastReport({ ok: true });
    expect(textOf(find(r.root, TEST_IDS.reportThanks)[0])).toBe("Gracias, lo revisaremos");
  });

  it("in Spanish, the owner muted by the report: «Has silenciado a bob»", async () => {
    mockT = es;
    await mount();
    act(() => mockSocket.fire("round-reveal", reveal("bob")));
    press(r.root, TEST_IDS.reportPhotoButton);
    press(r.root, reportReasonId("other"));
    await answerLastReport({ ok: true });
    expect(textOf(find(r.root, TEST_IDS.reportMutedNotice)[0])).toBe("Has silenciado a bob");
  });
});
