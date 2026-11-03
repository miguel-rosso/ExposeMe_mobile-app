import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import { StyleSheet } from "react-native";
import EmojiReaction from "../src/components/IngameComunication/EmojiReaction";
import EmojiReactionLane, { REACTION_LANE_GAP, REACTION_PILL_HEIGHT } from "../src/components/IngameComunication/EmojiReactionLane";
import ProgressBar from "../src/components/ProgressBar";
import { useRoomReactions } from "../src/components/IngameComunication/RoomReactionLane";
import { NOBODY_MUTED } from "../src/hooks/useMutedPlayers";

// EXP-166: room emoji reactions are capped on screen, only known emojis are shown, they don't replay on the next photo,
// and the screenshot reaction is a single listener per game that sends the fixed "📸" (label translated locally).
// EXP-201: reactions live in their own lane between the progress bar and the answer buttons, never over either.
// EXP-393: the lane owns its reactions and their listener, so a reaction never re-renders the game screen; arrivals are
// shown once per frame and a reaction pushed out by the cap ending its animation changes nothing.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
// Times the game screen rendered: it draws the (mocked) photo on every render while a photo is shown
const mockScreenRenders = { count: 0 };
// Screenshot listeners currently subscribed, and how many were ever added
const mockCapture = { listeners: new Set<() => void>(), added: 0, removed: 0 };

jest.mock("expo-screen-capture", () => ({
  addScreenshotListener: (fn: () => void) => {
    mockCapture.listeners.add(fn);
    mockCapture.added++;
    return { remove: () => { mockCapture.listeners.delete(fn); mockCapture.removed++; } };
  },
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
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
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/es").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => { mockScreenRenders.count++; return null; });
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);
// Times the reaction lane drew its pills (the real lane, counted)
const mockLaneDraws = { count: 0 };
jest.mock("../src/components/IngameComunication/EmojiReactionLane", () => {
  const actual = jest.requireActual("../src/components/IngameComunication/EmojiReactionLane");
  const React = require("react");
  return {
    ...actual,
    __esModule: true,
    default: (props: object) => { mockLaneDraws.count++; return React.createElement(actual.default, props); },
  };
});

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

// The test renderer reports a memoised component under its inner function
const EmojiReactionPill = (EmojiReaction as unknown as { type: React.ComponentType<any> }).type;
const reactions = (r: TestRenderer.ReactTestRenderer) => r.root.findAllByType(EmojiReactionPill);
// Arrivals are shown on the next frame
const FRAME_MS = 16;
const nextFrame = () => act(() => { jest.advanceTimersByTime(FRAME_MS); });
const startRound = (round: number) =>
  act(() => mockSocket.fire("round-start", { photo: `/temp/${round}.jpg`, round, duration: 8_000 }));
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
    nextFrame();
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
    nextFrame();
    expect(reactions(r).map((n) => n.props.emoji)).toEqual(["📸", "😂"]); // newest first
    act(() => r.unmount());
  });

  it("drops queued reactions when the next photo is awaited", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 3; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }); });
    nextFrame();
    expect(reactions(r)).toHaveLength(3);
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    // Reactions while no photo is shown are not queued either
    act(() => mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }));
    nextFrame();
    startRound(2);
    nextFrame();
    expect(reactions(r)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("drops queued reactions when a pause between rounds resumes into the next photo", async () => {
    const r = await mount();
    startRound(1);
    act(() => { for (let i = 0; i < 3; i++) mockSocket.fire("emoji-reaction", { username: "alice", emoji: "😂" }); });
    nextFrame();
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
    nextFrame();

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
  const reactionList = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, username: `p${i}`, emoji: "😭", photo: "/temp/1.jpg" }));
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
    expect(r.root.findAllByType(EmojiReactionPill).map((n) => n.props.username)).toEqual(["p4", "p3"]);
    act(() => r.unmount());
  });

  it("shows none when not even one pill fits, and all of them before the answers are measured", () => {
    const tooShort = renderLane(3, REACTION_PILL_HEIGHT - 1);
    expect(tooShort.root.findAllByType(EmojiReactionPill)).toHaveLength(0);
    act(() => tooShort.unmount());
    const unmeasured = renderLane(3, null);
    expect(unmeasured.root.findAllByType(EmojiReactionPill)).toHaveLength(3);
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
    act(() => { r = TestRenderer.create(<EmojiReaction id="r1" username="alice" emoji="📸" screenshotLabel="hizo una captura" onAnimationEnd={() => {}} />); });
    expect(allText(r)).toContain("📸 hizo una captura");
    act(() => r.update(<EmojiReaction id="r1" username="alice" emoji="😂" screenshotLabel="hizo una captura" onAnimationEnd={() => {}} />));
    expect(allText(r)).not.toContain("😂 hizo una captura");
    act(() => r.unmount());
  });
});

describe("GameScreen: reaction render cost (EXP-393)", () => {
  // One pill's whole animation (fade in, hold, fade out), with room to spare
  const PILL_ANIMATION_MS = 3_000;
  const fireReaction = (username: string) =>
    act(() => mockSocket.fire("emoji-reaction", { username, emoji: "🔥" }));
  // Counts commits anywhere under the screen: the screen itself or only the lane
  const mountProfiled = async () => {
    const commits = { count: 0 };
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(
        <React.Profiler id="game" onRender={() => { commits.count++; }}><GameScreen /></React.Profiler>
      );
    });
    return { r, commits };
  };

  it("never re-renders the game screen: not when reactions arrive, end or are pushed out", async () => {
    const r = await mount();
    startRound(1);
    expect(mockScreenRenders.count).toBeGreaterThan(0); // the photo is drawn, so screen renders are counted
    const screenRenders = mockScreenRenders.count;

    for (let i = 0; i < 8; i++) { fireReaction(`p${i}`); nextFrame(); } // the last 3 push the oldest out
    expect(reactions(r).map((n) => n.props.username)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    act(() => { jest.advanceTimersByTime(PILL_ANIMATION_MS); });
    expect(reactions(r)).toHaveLength(0);

    expect(mockScreenRenders.count).toBe(screenRenders);
    act(() => r.unmount());
  });

  it("shows the reactions that arrive within one frame in a single render", async () => {
    const { r, commits } = await mountProfiled();
    startRound(1);
    const before = commits.count;
    // Separate socket messages, as they come from the room
    for (let i = 0; i < 4; i++) fireReaction(`p${i}`);
    expect(commits.count).toBe(before);
    nextFrame();
    expect(commits.count).toBe(before + 1);
    expect(reactions(r).map((n) => n.props.username)).toEqual(["p3", "p2", "p1", "p0"]);
    act(() => r.unmount());
  });

  it("keeps the props of the pills already shown when another arrives, so the memoised pill skips its render", async () => {
    const r = await mount();
    startRound(1);
    fireReaction("alice");
    nextFrame();
    const firstProps = reactions(r)[0].props;
    fireReaction("bob");
    nextFrame();
    const alice = reactions(r).find((n) => n.props.username === "alice")!;
    expect(Object.keys(firstProps).every((k) => alice.props[k] === firstProps[k])).toBe(true);
    act(() => r.unmount());
  });

  it("redraws nothing when a reaction pushed out by the cap ends its animation", async () => {
    // p0's animation goes on after newer reactions push it out of the lane, and reports its end
    const P0_HEAD_START_MS = 1_000;
    const UNTIL_P0_ENDS_MS = 1_700; // p0 ends inside this window, p1..p5 only ~1 s after it
    const r = await mount();
    startRound(1);
    fireReaction("p0");
    nextFrame();
    act(() => { jest.advanceTimersByTime(P0_HEAD_START_MS); });
    for (let i = 1; i <= 5; i++) fireReaction(`p${i}`); // the 6th on screen: p0 is pushed out
    nextFrame();
    expect(reactions(r).map((n) => n.props.username)).toEqual(["p5", "p4", "p3", "p2", "p1"]);

    const laneDraws = mockLaneDraws.count;
    act(() => { jest.advanceTimersByTime(UNTIL_P0_ENDS_MS); });
    expect(mockLaneDraws.count).toBe(laneDraws);
    expect(reactions(r)).toHaveLength(5);
    act(() => r.unmount());
  });
});

describe("GameScreen: reaction listener (EXP-393)", () => {
  const reactionListeners = () => mockSocket.listenerCount("emoji-reaction");
  const fireRoundStart = (photo: string) => mockSocket.fire("round-start", { photo, round: 1, duration: 8_000 });
  const fireReaction = (username: string) => mockSocket.fire("emoji-reaction", { username, emoji: "🔥" });
  const shownUsers = (r: TestRenderer.ReactTestRenderer) => reactions(r).map((n) => n.props.username);

  it("listens with a single listener for the whole game, also between photos, and stops on unmount", async () => {
    const r = await mount();
    expect(reactionListeners()).toBe(1);
    startRound(1);
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    expect(reactionListeners()).toBe(1);
    startRound(2);
    expect(reactionListeners()).toBe(1);
    act(() => r.unmount());
    expect(reactionListeners()).toBe(0);
  });

  it("stops listening at game over", async () => {
    const r = await mount();
    startRound(1);
    act(() => mockSocket.fire("game-over", { finalScore: [] }));
    expect(reactionListeners()).toBe(0);
    act(() => r.unmount());
  });

  it("keeps a reaction that arrives after the next photo's round-start, before the screen draws that photo", async () => {
    const r = await mount();
    startRound(1);
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 10_000 }));
    // Both socket messages before the screen renders round 2
    act(() => { fireRoundStart("/temp/2.jpg"); fireReaction("alice"); });
    nextFrame();
    expect(shownUsers(r)).toEqual(["alice"]);
    act(() => r.unmount());
  });

  it("swapping straight to another photo keeps only the reactions sent after the swap", async () => {
    const r = await mount();
    startRound(1);
    act(() => fireReaction("alice"));
    nextFrame();
    act(() => { fireReaction("bob"); fireRoundStart("/temp/other.jpg"); fireReaction("carol"); });
    nextFrame();
    expect(shownUsers(r)).toEqual(["carol"]);
    act(() => r.unmount());
  });

  it("never shows a reaction still waiting for its frame over the next photo", async () => {
    const r = await mount();
    startRound(1);
    act(() => fireReaction("alice"));
    act(() => fireRoundStart("/temp/other.jpg")); // drawn before alice's frame
    nextFrame();
    expect(reactions(r)).toHaveLength(0);
    act(() => r.unmount());
  });

  it("ignores reactions while no photo is shown", async () => {
    const r = await mount();
    act(() => fireReaction("alice")); // ready phase
    nextFrame();
    startRound(1);
    nextFrame();
    expect(reactions(r)).toHaveLength(0);
    act(() => r.unmount());
  });
});

describe("useRoomReactions: socket change (EXP-393)", () => {
  it("moves its listener to the new socket and removes it on unmount", () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const latestPhoto = () => "/temp/1.jpg";
    const Harness = ({ socket }: { socket: FakeSocket }) => {
      useRoomReactions({ socket: socket as any, listening: true, photo: "/temp/1.jpg", latestPhoto, muted: NOBODY_MUTED });
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Harness socket={first} />); });
    expect(first.listenerCount("emoji-reaction")).toBe(1);
    act(() => r.update(<Harness socket={second} />));
    expect(first.listenerCount("emoji-reaction")).toBe(0);
    expect(second.listenerCount("emoji-reaction")).toBe(1);
    act(() => r.unmount());
    expect(second.listenerCount("emoji-reaction")).toBe(0);
  });
});
