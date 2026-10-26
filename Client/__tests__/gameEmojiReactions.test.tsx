import React from "react";
import TestRenderer, { act } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { StyleSheet } from "react-native";
import EmojiReaction from "../app/components/IngameComunication/EmojiReaction";
import EmojiReactionLane, { REACTION_LANE_GAP, REACTION_PILL_HEIGHT } from "../app/components/IngameComunication/EmojiReactionLane";
import ProgressBar from "../app/components/ProgressBar";

// EXP-166: room emoji reactions are capped on screen, only known emojis are shown, they don't replay on the next photo,
// and the screenshot reaction is a single listener per game that sends the fixed "📸" (label translated locally).
// EXP-201: reactions live in their own lane between the progress bar and the answer buttons, never over either.

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
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
// Screenshot listeners currently subscribed, and how many were ever added
const mockCapture = { listeners: new Set<() => void>(), added: 0, removed: 0 };

jest.mock("expo-screen-capture", () => ({
  addScreenshotListener: (fn: () => void) => {
    mockCapture.listeners.add(fn);
    mockCapture.added++;
    return { remove: () => { mockCapture.listeners.delete(fn); mockCapture.removed++; } };
  },
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
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
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/es").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.handlers.clear();
  mockSocket.emitted = [];
  mockCapture.listeners.clear();
  mockCapture.added = 0;
  mockCapture.removed = 0;
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const reactions = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(EmojiReaction);
const startRound = (round: number) =>
  act(() => mockSocket.fire("round-start", { photo: `/temp/${round}.jpg`, round, duration: 8_000, isOwner: false }));
const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  return r;
};

describe("GameScreen: emoji reactions (EXP-166)", () => {
  it("shows at most 5 of a flood of 100 reactions, the newest ones", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 100; i++) mockSocket.fire("emoji-reaction", { username: `p${i}`, emoji: "🔥" }); });
    const shown = reactions(r);
    expect(shown.length).toBeLessThanOrEqual(5);
    // Newest on top of the lane
    expect(shown.map((n) => n.props.username)).toEqual(["p99", "p98", "p97", "p96", "p95"]);
    act(() => r.unmount());
  });

  it("ignores reactions that are not in the picker's list", async () => {
    const r = await mount();
    startRound(1);
    act(() => {
      mockSocket.fire("emoji-reaction", { username: "alice", emoji: "📸 Took a Screenshot" });
      mockSocket.fire("emoji-reaction", { username: "alice", emoji: "hello there" });
      mockSocket.fire("emoji-reaction", { username: "alice", emoji: 42 });
      mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" });
      mockSocket.fire("emoji-reaction", { username: "alice", emoji: "📸" });
    });
    expect(reactions(r).map((n) => n.props.emoji)).toEqual(["📸", "😂"]); // newest first
    act(() => r.unmount());
  });

  it("drops queued reactions when the next photo is awaited", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 3; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }); });
    expect(reactions(r)).toHaveLength(3);
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    // Reactions while no photo is shown are not queued either
    act(() => mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }));
    startRound(2);
    expect(reactions(r)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("drops queued reactions when a pause between rounds resumes into the next photo", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 3; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }); });
    expect(reactions(r)).toHaveLength(3);
    act(() => mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 10_000 }));
    startRound(2);
    expect(reactions(r)).toHaveLength(0);
    act(() => r.unmount());
  });
});

describe("GameScreen: screenshot reaction (EXP-166)", () => {
  it("subscribes once for the whole game, sends the fixed emoji, and unsubscribes on unmount", async () => {
    const r = await mount();
    for (let round = 1; round <= 3; round++) {
      act(() => mockSocket.fire("waiting-photo", { round, duration: 10_000 }));
      startRound(round);
    }
    expect(mockCapture.added).toBe(1);
    expect(mockCapture.listeners.size).toBe(1);

    act(() => [...mockCapture.listeners].forEach((fn) => fn()));
    expect(mockSocket.emitted.filter(([ev]) => ev === "emoji-reaction")).toEqual([["emoji-reaction", { emoji: "📸" }]]);

    act(() => r.unmount());
    expect(mockCapture.listeners.size).toBe(0);
    expect(mockCapture.removed).toBe(1);
  });
});

describe("GameScreen: reaction lane layout (EXP-201)", () => {
  type Node = TestRenderer.ReactTestInstance;
  const flatStyle = (n: Node) => StyleSheet.flatten(n.props.style) ?? {};
  const isInside = (n: Node, container: Node) => {
    for (let p: Node | null = n.parent; p; p = p.parent) if (p === container) return true;
    return false;
  };
  // Nearest ancestor positioned with an explicit top: the strip that holds the progress bar
  const progressBarArea = (r: TestRenderer.ReactTestRenderer) => {
    let n: Node | null = r.root.findByType(ProgressBar as React.ComponentType<any>);
    while (n && typeof flatStyle(n).top !== "number") n = n.parent;
    return flatStyle(n!) as { top: number; height: number };
  };
  const laneView = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findByType(EmojiReactionLane).findAll((n) => (n.type as unknown) === "View")[0];
  const answersContainer = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => (n.type as unknown) === "View" && typeof n.props.onLayout === "function"
      && n.findAll((c) => typeof c.props.testID === "string" && c.props.testID.startsWith("player-option-")).length > 0)[0];

  it("stacks reactions in a lane that starts below the progress bar", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 5; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😭" }); });

    const lane = r.root.findByType(EmojiReactionLane);
    expect(reactions(r)).toHaveLength(5);
    reactions(r).forEach((reaction) => expect(isInside(reaction, lane)).toBe(true));

    const bar = progressBarArea(r);
    expect(flatStyle(laneView(r)).top).toBeGreaterThanOrEqual(bar.top + bar.height);
    act(() => r.unmount());
  });

  it("ends the lane above the answer buttons and follows them when they move", async () => {
    const r = await mount();
    startRound(1);
    const layoutAnswersAt = (y: number) =>
      act(() => answersContainer(r).props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 400, height: 200 } } }));

    layoutAnswersAt(520);
    expect(flatStyle(laneView(r)).top + flatStyle(laneView(r)).maxHeight).toBe(520 - REACTION_LANE_GAP);
    // More players (or landscape): the answer grid grows upwards and the lane shrinks with it
    layoutAnswersAt(380);
    const lane = flatStyle(laneView(r));
    expect(lane.overflow).toBe("hidden");
    expect(lane.top + lane.maxHeight).toBe(380 - REACTION_LANE_GAP);
    act(() => r.unmount());
  });
});

describe("EmojiReactionLane", () => {
  const reactionList = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, username: `p${i}`, emoji: "😭" }));
  const renderLane = (count: number, laneHeight: number | null) => {
    const top = 100;
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <EmojiReactionLane
          reactions={reactionList(count)}
          top={top}
          answersTop={laneHeight === null ? null : top + laneHeight + REACTION_LANE_GAP}
          screenshotLabel=""
          onReactionEnd={() => {}}
        />
      );
    });
    return r;
  };

  it("shows only the newest reactions that fit whole", () => {
    const r = renderLane(5, REACTION_PILL_HEIGHT * 2.5);
    expect(r.root.findAllByType(EmojiReaction).map((n) => n.props.username)).toEqual(["p4", "p3"]);
    act(() => r.unmount());
  });

  it("shows none when not even one pill fits, and all of them before the answers are measured", () => {
    const tooShort = renderLane(3, REACTION_PILL_HEIGHT - 1);
    expect(tooShort.root.findAllByType(EmojiReaction)).toHaveLength(0);
    act(() => tooShort.unmount());
    const unmeasured = renderLane(3, null);
    expect(unmeasured.root.findAllByType(EmojiReaction)).toHaveLength(3);
    act(() => unmeasured.unmount());
  });

  it("never gets a negative height when the answers reach the lane", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <EmojiReactionLane reactions={[]} top={100} answersTop={90} screenshotLabel="" onReactionEnd={() => {}} />
      );
    });
    const lane = r.root.findAll((n) => (n.type as unknown) === "View")[0];
    expect(StyleSheet.flatten(lane.props.style).maxHeight).toBe(0);
    act(() => r.unmount());
  });
});

describe("GameScreen: screenshot reaction across remounts (EXP-201)", () => {
  it("keeps a single listener, so one screenshot sends exactly one reaction", async () => {
    let r = await mount();
    // Re-renders driven by room events must not subscribe again
    startRound(1);
    act(() => { for (let i = 0; i < 3; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }); });
    act(() => r.unmount());
    r = await mount();
    startRound(2);

    expect(mockCapture.added).toBe(2);
    expect(mockCapture.removed).toBe(1);
    expect(mockCapture.listeners.size).toBe(1);

    act(() => [...mockCapture.listeners].forEach((fn) => fn()));
    expect(mockSocket.emitted.filter(([ev]) => ev === "emoji-reaction")).toEqual([["emoji-reaction", { emoji: "📸" }]]);
    act(() => r.unmount());
    expect(mockCapture.listeners.size).toBe(0);
  });
});

describe("EmojiReaction: screenshot label", () => {
  const allText = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));

  it("shows the translated label only for the fixed screenshot emoji", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<EmojiReaction username="alice" emoji="📸" screenshotLabel="hizo una captura" onAnimationEnd={() => {}} />); });
    expect(allText(r)).toContain("📸 hizo una captura");
    act(() => r.update(<EmojiReaction username="alice" emoji="😂" screenshotLabel="hizo una captura" onAnimationEnd={() => {}} />));
    expect(allText(r)).not.toContain("😂 hizo una captura");
    act(() => r.unmount());
  });
});
