import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS, playerOptionId } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-063: the game screen only paints the server's phases with the `duration` it receives (GAME_FLOW.md): one
// progress bar per phase (a fresh one for every phase, hold-resume and game-resumed), none in reveal or while
// paused, the score modal in scores, and the owner's hold button driving hold-start / hold-end.

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
// The score modal's props, as the screen passes them
jest.mock("@/app/components/modals/ScoreModal", () => (p: any) => {
  const { View } = require("react-native");
  return <View testID="score-modal-probe" {...p} />;
});
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
// Each mounted bar gets its own id, so a restarted bar (new key) is told apart from a re-render of the same one
let mockBarSeq = 0;
jest.mock("@/app/components/ProgressBar", () => (p: { duration: number }) => {
  const React = require("react");
  const { View } = require("react-native");
  const [id] = React.useState(() => ++mockBarSeq);
  return <View testID="progress-bar" duration={p.duration} barId={id} />;
});

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const byId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id && typeof n.type === "string");
const has = (root: ReactTestInstance, id: string) => byId(root, id).length > 0;
const bar = (root: ReactTestInstance) => {
  const bars = byId(root, "progress-bar");
  expect(bars.length).toBeLessThanOrEqual(1);
  return bars[0] ? { duration: bars[0].props.duration as number, id: bars[0].props.barId as number } : null;
};
const scoreModal = (root: ReactTestInstance) => byId(root, "score-modal-probe")[0]?.props;
const emitted = (ev: string) => mockSocket.emitted.filter(([e]) => e === ev);

const START = { photo: "/temp/x.jpg", round: 1, duration: 7_700 };
const SCORES = [
  { username: "alice", points: 1, lastAnswerCorrect: true, lastGuess: "carol" },
  { username: "bob", points: 0, lastAnswerCorrect: false, lastGuess: "alice" },
];

describe("GameScreen: server phases drawn with the received duration (EXP-063)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    mockSocket.emitted = [];
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("says im-ready once on mount and waits on the ready screen until the first round", () => {
    expect(emitted("im-ready")).toHaveLength(1);
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(bar(r.root)).toBeNull();
  });

  it("answering -> reveal -> scores -> next wait: each phase with its own bar of the server's duration", () => {
    act(() => mockSocket.fire("round-start", START));
    expect(has(r.root, playerOptionId("alice"))).toBe(true);
    const answering = bar(r.root)!;
    expect(answering.duration).toBe(7_700);
    expect(scoreModal(r.root).visible).toBe(false);

    // The client never runs a timer of its own: time passing changes nothing until the server moves on
    act(() => jest.advanceTimersByTime(60_000));
    expect(bar(r.root)!.id).toBe(answering.id);
    expect(has(r.root, playerOptionId("alice"))).toBe(true);

    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000 }));
    expect(bar(r.root)).toBeNull(); // no bar in reveal
    expect(scoreModal(r.root).visible).toBe(false);
    expect(scoreModal(r.root).correctAnswer).toBe("carol");

    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    expect(bar(r.root)!.duration).toBe(5_000);
    const modal = scoreModal(r.root);
    expect(modal.visible).toBe(true);
    expect(modal.scoreRound).toEqual(SCORES);
    expect(modal.rounds).toEqual({ round: 1, roundsOfGame: 10 });
    expect(modal.myUsername).toBe("bob");

    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(has(r.root, "score-modal-probe")).toBe(false);
    expect(bar(r.root)!.duration).toBe(15_000);

    act(() => mockSocket.fire("round-start", { ...START, photo: "/temp/y.jpg", round: 2, duration: 7_000 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(false);
    expect(bar(r.root)!.duration).toBe(7_000);
    expect(scoreModal(r.root).correctAnswer).toBe(""); // the previous answer is not carried over
  });

  it("a hold hides the overlay and freezes; hold-resume draws a fresh bar with the remaining time", () => {
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));

    act(() => mockSocket.fire("hold-start"));
    expect(bar(r.root)).toBeNull();
    expect(has(r.root, "score-modal-probe")).toBe(false);
    expect(has(r.root, playerOptionId("alice"))).toBe(false);

    act(() => mockSocket.fire("hold-resume", { phase: "scores", duration: 2_400 }));
    expect(bar(r.root)!.duration).toBe(2_400);
    expect(scoreModal(r.root).visible).toBe(true);
  });

  it("hold-end from the server (force release) shows the overlay again", () => {
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => mockSocket.fire("hold-start"));
    expect(has(r.root, "score-modal-probe")).toBe(false);
    act(() => mockSocket.fire("hold-end"));
    expect(scoreModal(r.root).visible).toBe(true);
  });

  it("the owner's hold button sends hold-start on press and hold-end on release, only in scores", () => {
    act(() => mockSocket.fire("round-start", START));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false); // not while answering
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));

    const button = () => r.root.find((n) => n.props.testID === TEST_IDS.holdButton && typeof n.props.onPressIn === "function");
    act(() => button().props.onPressIn());
    act(() => button().props.onPressIn()); // a second press while held sends nothing more
    expect(emitted("hold-start")).toHaveLength(1);
    act(() => mockSocket.fire("hold-start")); // the server's echo hides the overlay; the button (owner, still in scores) stays to catch the release
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
    act(() => button().props.onPressOut());
    expect(emitted("hold-end")).toHaveLength(1);
    act(() => button().props.onPressOut()); // released already
    expect(emitted("hold-end")).toHaveLength(1);
  });

  it("game-paused hides the bar behind the paused modal; game-resumed restarts it with the server's remaining time", () => {
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(true);
    expect(bar(r.root)).toBeNull();

    act(() => mockSocket.fire("game-resumed", { phase: "answering", duration: 4_200 }));
    expect(has(r.root, TEST_IDS.pausedModal)).toBe(false);
    expect(bar(r.root)!.duration).toBe(4_200);
    expect(has(r.root, playerOptionId("alice"))).toBe(true); // same round, same photo
  });

  it("the next round drops a hold still pressed (the button goes), and the owner can hold again later", () => {
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    const button = () => r.root.find((n) => n.props.testID === TEST_IDS.holdButton && typeof n.props.onPressIn === "function");
    act(() => button().props.onPressIn());
    expect(emitted("hold-start")).toHaveLength(1);

    // The server moved on (it ends the hold itself): every phase change resets the press, so the button unmounts
    // and a new press is not ignored
    act(() => mockSocket.fire("round-start", { ...START, photo: "/temp/y.jpg", round: 2 }));
    expect(has(r.root, TEST_IDS.holdButton)).toBe(false);

    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 2, totalRounds: 10, duration: 5_000 }));
    act(() => button().props.onPressIn());
    expect(emitted("hold-start")).toHaveLength(2);
  });

  // EXP-189: the hold button exists only for the photo owner and only in scores (no press keeps it in another phase).
  // EXP-252: the owner is only known from the reveal (correctAnswer names me, bob)
  it("the hold button is mounted only in scores, only for the owner, also while pressed", () => {
    const holdPhases = (mine: boolean) => {
      const seen: string[] = [];
      const check = (phase: string) => { if (has(r.root, TEST_IDS.holdButton)) seen.push(phase); };
      act(() => mockSocket.fire("round-start", START));
      check("answering");
      act(() => mockSocket.fire("round-reveal", { correctAnswer: mine ? "bob" : "carol", duration: 3_000 }));
      check("reveal");
      act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
      check("scores");
      const button = r.root.findAll((n) => n.props.testID === TEST_IDS.holdButton && typeof n.props.onPressIn === "function")[0];
      if (button) {
        act(() => button.props.onPressIn());
        check("scores (pressed)");
      }
      act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
      check("waiting-photo");
      return seen;
    };
    expect(holdPhases(false)).toEqual([]);
    expect(holdPhases(true)).toEqual(["scores", "scores (pressed)"]);
  });

  // EXP-141: with many players the answer list reached under the scoreboard; it is not drawn in scores at all
  it("the answer options are not rendered while the scoreboard shows, and come back with the next round", () => {
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000 }));
    expect(has(r.root, playerOptionId("alice"))).toBe(true); // the reveal colours them

    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    expect(scoreModal(r.root).visible).toBe(true);
    expect(mockPlayers.filter((p) => has(r.root, playerOptionId(p.username)))).toEqual([]);

    // A rejoin snapshot in scores draws the same screen
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "scores", round: 1, totalRounds: 10, photo: "/temp/x.jpg",
      correctAnswer: "carol", duration: 4_000, held: false, pause: null, scores: SCORES, players: mockPlayers,
    }));
    expect(has(r.root, playerOptionId("alice"))).toBe(false);

    act(() => mockSocket.fire("round-start", { ...START, photo: "/temp/y.jpg", round: 2 }));
    expect(has(r.root, playerOptionId("alice"))).toBe(true);
  });

  it("the owner answers like everyone, and their scoreboard keeps room for the hold button", () => {
    act(() => mockSocket.fire("round-start", START));
    expect(has(r.root, playerOptionId("bob"))).toBe(true); // my own name too: I'm not told it's my photo
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "bob", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    expect(has(r.root, playerOptionId("alice"))).toBe(false);
    expect(scoreModal(r.root).reserveHoldButton).toBe(true);
    expect(has(r.root, TEST_IDS.holdButton)).toBe(true);
  });

  // The bar is keyed by phase: every new duration from the server must restart it, also when it stays on screen
  // (otherwise the old animation would keep running and close the answers at the wrong time)
  describe("restarts the bar even when it never left the screen", () => {
    it("answering -> scores with no reveal in between", () => {
      act(() => mockSocket.fire("round-start", START));
      const answering = bar(r.root)!;
      act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
      const scores = bar(r.root)!;
      expect(scores.duration).toBe(5_000);
      expect(scores.id).not.toBe(answering.id);
    });

    it("round-start -> round-start (next round)", () => {
      act(() => mockSocket.fire("round-start", START));
      const first = bar(r.root)!;
      act(() => mockSocket.fire("round-start", { ...START, photo: "/temp/y.jpg", round: 2, duration: 7_700 }));
      const second = bar(r.root)!;
      expect(second.duration).toBe(7_700);
      expect(second.id).not.toBe(first.id);
    });

    it("hold-resume while the bar is showing (its hold-start was missed)", () => {
      act(() => mockSocket.fire("round-start", START));
      act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
      const before = bar(r.root)!;
      act(() => mockSocket.fire("hold-resume", { phase: "scores", duration: 5_000 }));
      const after = bar(r.root)!;
      expect(after.duration).toBe(5_000);
      expect(after.id).not.toBe(before.id);
    });

    it("game-resumed while the bar is showing (its game-paused was missed)", () => {
      act(() => mockSocket.fire("round-start", START));
      const before = bar(r.root)!;
      act(() => mockSocket.fire("game-resumed", { phase: "answering", duration: 7_700 }));
      const after = bar(r.root)!;
      expect(after.duration).toBe(7_700);
      expect(after.id).not.toBe(before.id);
    });
  });
});

// EXP-012: QA builds tell the server when each phase was rendered (lab render-skew metrics); other builds never do
describe("GameScreen: qa-ack render telemetry (EXP-012)", () => {
  const original = process.env.EXPO_PUBLIC_QA;

  async function playRound(qa: string | undefined) {
    if (qa === undefined) delete process.env.EXPO_PUBLIC_QA;
    else process.env.EXPO_PUBLIC_QA = qa;
    mockSocket.emitted = [];
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("round-start", START));
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "carol", duration: 3_000 }));
    act(() => mockSocket.fire("round-scores", { scores: SCORES, round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => r.unmount());
  }

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_QA;
    else process.env.EXPO_PUBLIC_QA = original;
  });

  it("with EXPO_PUBLIC_QA=1 acks every rendered phase once", async () => {
    await playRound("1");
    expect(emitted("qa-ack").map(([, d]) => [d.phase, d.round])).toEqual([
      ["waiting-photo", 1], ["answering", 1], ["reveal", 1], ["scores", 1],
    ]);
  });

  it("each phase's ack carries the device time its socket handler got the event, taken before the paint (EXP-223)", async () => {
    let clock = 1_000;
    jest.spyOn(Date, "now").mockImplementation(() => ++clock); // every reading is later than the one before
    try {
      await playRound("1");
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
    const acks = emitted("qa-ack").map(([, d]) => d);
    expect(acks).toHaveLength(4);
    acks.forEach((ack) => {
      expect(ack.handledAt).toEqual(expect.any(Number));
      expect(ack.handledAt).toBeLessThan(ack.at);
    });
  });

  it("sends no qa-ack in regular builds", async () => {
    await playRound(undefined);
    expect(emitted("qa-ack")).toHaveLength(0);
  });
});
