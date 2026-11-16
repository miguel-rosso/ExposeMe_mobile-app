import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
// expo-router's own boundary, the one that renders the root stack's unstable_screenErrorBoundary around a screen
import { Try } from "expo-router/build/views/Try";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS, playerOptionId } from "../src/utils/testIds";
import { GameStateSnapshot, Player } from "../src/models/interfaces";
import { ScreenErrorBoundary } from "../src/components/ErrorScreen";
import { RETRY_RESYNC_INTERVAL_MS } from "../src/hooks/useRetryResync";
import { useGameConnection } from "../src/hooks/useGameConnection";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-446: when the game screen failed to render mid-round, Retry on its error screen mounted it again with nothing on
// screen until the next phase: the server sends a phase's events once, and ignores im-ready once the game runs. A
// retried game screen now asks for the game again once it has mounted (the same join on its bound socket, a no-op the
// server answers with the game-state snapshot and an awaited your-turn). A first mount from the lobby sends no extra
// join, a Retry that fails again sends none, and retries are spaced so the server's join limit (5 per socket in any
// 10 s, "Too many attempts" would send the player home) is never reached.

jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
// Try hides the splash screen when it catches an error
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));

const mockSocket = new FakeSocket();
const mockPlayers: Player[] = ["alice", "bob"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
const mockReplace = jest.fn();
// Opened by the lobby on game-started: the game screen knows its game number from the start
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({ gameNumber: "1" }),
  ...require("../testUtils/screenNavigation").screenNavigationMock(undefined, "screens/GameScreen"),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    clearRejoinToken: jest.fn(), setPlantedPhotoUri: jest.fn(), setHomeNotice: jest.fn(), markRoomExit: jest.fn(),
    leaveRoom: jest.fn(), takeInviteOverRoomScreen: () => null,
  }),
}));
// PhotoContext's photo memory (EXP-162): a photo picked this game is not picked again until the game screen resets it
const mockGallery = {
  photos: ["file:///a.jpg", "file:///b.jpg", "file:///c.jpg"],
  used: new Set<string>(),
  picked: [] as string[],
};
jest.mock("../src/providers/PhotoContext", () => {
  // Stable functions, like the provider's callbacks
  const photoContext = {
    pickGamePhoto: async () => {
      const uri = mockGallery.photos.find((photo) => !mockGallery.used.has(photo)) ?? mockGallery.photos[0];
      mockGallery.used.add(uri);
      mockGallery.picked.push(uri);
      return { uri };
    },
    resetUsedPhotos: () => mockGallery.used.clear(),
    setPhotoUri: () => {},
  };
  return { usePhotoContext: () => photoContext };
});
// Uploads finish at once, unless held: then each waits for its release (an upload still running at a crash)
const mockUploads = { hold: false, release: [] as (() => void)[] };
jest.mock("@/src/utils/uploadPhoto", () => ({
  uploadPhoto: async (_server: string, uri: string) => {
    if (mockUploads.hold) await new Promise<void>((resolve) => mockUploads.release.push(resolve));
    return `/temp/${uri.split("/").pop()}`;
  },
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-animatable", () => {
  const { View } = require("react-native");
  return { View };
});
jest.mock("@/src/components/PhotoComponent", () => "PhotoComponent");
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
// A render error of the game screen: its final table (drawn, hidden, from the first frame) throws while it is on
const mockCrash = { on: false };
jest.mock("@/src/components/modals/FinalScoreModal", () => ({ visible }: { visible: boolean }) => {
  if (mockCrash.on) throw new Error("the game screen failed to render");
  const { View } = require("react-native");
  return visible ? <View testID="final-score-table" /> : null;
});
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

const PHOTO = "/temp/1-a.jpg";
const ROUND_START = { round: 2, photo: PHOTO, duration: 7700 };
const ROOM_OF_GAME = {
  success: true,
  room: { gameCode: "123456", players: mockPlayers, rounds: 10, started: true, gameNumber: 1 },
  rejoinToken: "tok-123",
  hasPlantedPhoto: false,
};
const SNAPSHOT: GameStateSnapshot = {
  started: true, gameNumber: 1, phase: "answering", round: 2, totalRounds: 10, photo: PHOTO, correctAnswer: null,
  yourGuess: null, duration: 4200, phaseTotal: 7700, held: false, holdsLeft: 3, pause: null,
  scores: mockPlayers.map(({ username, points, isHost }) => ({ username, points, isHost, lastAnswerCorrect: false, lastGuess: "" })),
  players: mockPlayers, roundOptions: mockPlayers,
};

/** The game screen as expo-router renders it under the root stack's screen error boundary */
const GameRoute = () => (
  <Try catch={ScreenErrorBoundary}>
    <GameScreen />
  </Try>
);

let app: TestRenderer.ReactTestRenderer | null = null;
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const root = () => app!.root;
const has = (id: string) => root().findAll((n) => n.props.testID === id && typeof n.type === "string").length > 0;
const photoShown = () => root().findAll((n) => n.type === ("PhotoComponent" as unknown as React.ElementType)).length > 0;
const joins = () => mockSocket.emittedPayloads("join-create-game");
const openGame = async () => {
  await act(async () => { app = TestRenderer.create(<GameRoute />); });
  await flush();
};
const retry = async () => {
  const button = root().find((n) => n.props.testID === TEST_IDS.errorScreenRetry && typeof n.props.onPress === "function");
  await act(async () => { button.props.onPress(); });
  await flush();
};
/** Renders the game screen again (with a crash on, it fails: the error screen takes its place) */
const rerender = () => act(() => app!.update(<GameRoute />));
/** The round in play, then a render error mid-round: the error screen takes the game screen's place */
const crashMidRound = async () => {
  act(() => mockSocket.fire("round-start", ROUND_START));
  await flush();
  mockCrash.on = true;
  act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3000, yourGuess: "" }));
  await flush();
  expect(has(TEST_IDS.errorScreen)).toBe(true);
};

// The retry spacing is module-wide (every retry is a new screen): each test starts well after the last one's resync
let clock = Date.UTC(2026, 0, 1);
beforeEach(() => {
  clock += 100 * RETRY_RESYNC_INTERVAL_MS;
  jest.useFakeTimers({ now: clock });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {}); // React and the error screen report the caught error
  mockSocket.reset();
  mockCrash.on = false;
  mockGallery.used.clear();
  mockGallery.picked = [];
  mockUploads.hold = false;
  mockUploads.release = [];
  mockReplace.mockClear();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("Retry on the game screen's error screen (EXP-446)", () => {
  it("a first mount from the lobby sends no join, only im-ready", async () => {
    await openGame();
    expect(joins()).toEqual([]);
    expect(mockSocket.emitted.map(([event]) => event)).toContain("im-ready");
    expect(has(TEST_IDS.gameWaitingReady)).toBe(true);
  });

  it("a retried mount asks once for the game, and its snapshot draws the round's photo and options again", async () => {
    await openGame();
    await crashMidRound();
    expect(joins()).toEqual([]);

    mockCrash.on = false;
    await retry();

    expect(has(TEST_IDS.errorScreen)).toBe(false);
    expect(joins()).toEqual([{ gameCode: "123456", username: "bob", rejoinToken: "tok-123" }]);
    // Its phase is unknown until the snapshot: a neutral loader, not "waiting for everyone to be ready"
    expect(has(TEST_IDS.gameLoading)).toBe(true);
    expect(has(TEST_IDS.gameWaitingReady)).toBe(false);

    act(() => {
      mockSocket.fire("room-of-game", ROOM_OF_GAME);
      mockSocket.fire("game-state", SNAPSHOT);
    });
    await flush();

    expect(photoShown()).toBe(true);
    expect(has(playerOptionId("alice"))).toBe(true);
    expect(has(playerOptionId("bob"))).toBe(true);
    expect(has(TEST_IDS.gameLoading)).toBe(false);
    expect(joins()).toHaveLength(1);
  });

  it("a Retry that fails again sends no join, and leaves no retry behind for the next game screen", async () => {
    await openGame();
    await crashMidRound();

    await retry();
    await retry();
    expect(has(TEST_IDS.errorScreen)).toBe(true);
    expect(joins()).toEqual([]);

    // Out of that screen (Back to home), then a new game screen opened by the lobby: a first mount again
    act(() => app!.unmount());
    mockCrash.on = false;
    await openGame();
    expect(joins()).toEqual([]);
    expect(has(TEST_IDS.gameWaitingReady)).toBe(true);
  });

  it("asks at most once per join window however often Retry is tapped", async () => {
    await openGame();
    await crashMidRound();
    mockCrash.on = false;
    await retry();
    expect(joins()).toHaveLength(1);

    // Fails again right after the snapshot, and the player taps Retry at once: no second join in the window
    await crashMidRound();
    mockCrash.on = false;
    await retry();
    expect(joins()).toHaveLength(1);
    expect(has(TEST_IDS.gameLoading)).toBe(true);

    // Once the window is over, a retry asks again
    await crashMidRound();
    act(() => { jest.advanceTimersByTime(RETRY_RESYNC_INTERVAL_MS); });
    mockCrash.on = false;
    await retry();
    expect(joins()).toHaveLength(2);
  });

  it("a retried mount keeps the game's used photos: a later turn picks none of them again", async () => {
    const myTurn = async (round: number, attempt: number) => {
      act(() => {
        mockSocket.fire("waiting-photo", { round, duration: 15_000, gameNumber: 1 });
        mockSocket.fire("your-turn", { round, attempt });
      });
      await flush();
    };
    await openGame();
    await myTurn(1, 1);
    await myTurn(2, 2);
    expect(mockGallery.picked).toEqual(["file:///a.jpg", "file:///b.jpg"]);

    await crashMidRound();
    mockCrash.on = false;
    await retry();
    await myTurn(3, 3);
    expect(mockGallery.picked.at(-1)).toBe("file:///c.jpg");

    // A new game screen (the next game) starts its photo memory over
    act(() => app!.unmount());
    await openGame();
    await myTurn(1, 1);
    expect(mockGallery.picked.at(-1)).toBe("file:///a.jpg");
  });

  it("an upload still running at the crash is dropped: only the retried screen sends the turn's photo", async () => {
    await openGame();
    mockUploads.hold = true;
    act(() => {
      mockSocket.fire("waiting-photo", { round: 1, duration: 15_000, gameNumber: 1 });
      mockSocket.fire("your-turn", { round: 1, attempt: 1 });
    });
    await flush();
    expect(mockUploads.release).toHaveLength(1); // the crashed screen's upload, still running

    mockCrash.on = true;
    rerender(); // my request still in force
    await flush();
    expect(has(TEST_IDS.errorScreen)).toBe(true);
    mockCrash.on = false;
    await retry();

    // The resync's snapshot of the photo wait, and the server asks for my photo again (same attempt)
    act(() => {
      mockSocket.fire("game-state", { ...SNAPSHOT, phase: "waiting-photo", round: 1, photo: null, duration: 12_000, phaseTotal: 15_000 });
      mockSocket.fire("your-turn", { round: 1, attempt: 1 });
    });
    await flush();
    expect(mockUploads.release).toHaveLength(2);

    await act(async () => { mockUploads.release.forEach((release) => release()); });
    await flush();
    // The retried screen's own pick (A stays used by the crashed one's flow)
    expect(mockSocket.emittedPayloads("photo-sent")).toEqual([{ photo: "/temp/b.jpg" }]);
    expect(mockSocket.emittedPayloads("photo-unavailable")).toEqual([]);
  });

  // im-ready after the game is over is answered with the not-started snapshot and its final scores (GAME_FLOW.md)
  it("retried on the game-over screens, it shows the final table again, not a loader", async () => {
    await openGame();
    act(() => mockSocket.fire("game-over", { finalScore: SNAPSHOT.scores }));
    await flush();
    expect(has("final-score-table")).toBe(true);

    mockCrash.on = true;
    rerender();
    await flush();
    expect(has(TEST_IDS.errorScreen)).toBe(true);
    mockSocket.emitted = [];
    mockCrash.on = false;
    await retry();
    expect(mockSocket.emitted.map(([event]) => event)).toEqual(expect.arrayContaining(["im-ready", "join-create-game"]));

    act(() => {
      mockSocket.fire("room-of-game", { ...ROOM_OF_GAME, room: { ...ROOM_OF_GAME.room, started: false } });
      mockSocket.fire("game-state", { ...SNAPSHOT, started: false, phase: null, round: 0, photo: null, duration: 0, phaseTotal: 0 });
    });
    await flush();
    expect(has("final-score-table")).toBe(true);
    expect(has(TEST_IDS.gameLoading)).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("offline, a retried mount sends nothing: the reconnect's rejoin brings the snapshot", async () => {
    await openGame();
    await crashMidRound();
    mockSocket.connected = false;
    mockCrash.on = false;
    await retry();
    expect(joins()).toEqual([]);

    await act(async () => { mockSocket.connected = true; mockSocket.fire("connect"); });
    await flush();
    expect(joins()).toEqual([{ gameCode: "123456", username: "bob", rejoinToken: "tok-123" }]);
  });
});

describe("useGameConnection resync", () => {
  it("joins the game again on the connected socket with the stored token, and sends nothing offline", async () => {
    let resync!: () => Promise<void>;
    const Probe = () => {
      ({ resync } = useGameConnection({
        socket: mockSocket as any, gameCode: "123456", username: "bob", getRejoinToken: async () => "tok-123",
        saveRejoinToken: jest.fn(), onLeave: jest.fn(),
      }));
      return null;
    };
    act(() => { app = TestRenderer.create(<Probe />); });

    await act(async () => { await resync(); });
    expect(joins()).toEqual([{ gameCode: "123456", username: "bob", rejoinToken: "tok-123" }]);

    mockSocket.connected = false;
    await act(async () => { await resync(); });
    expect(joins()).toHaveLength(1);
  });
});
