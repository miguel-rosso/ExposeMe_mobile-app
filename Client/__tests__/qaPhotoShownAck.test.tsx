import React from "react";
import { Image, Platform } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { FakeXhr, installFakeXhr } from "../testUtils/fakeXhr";
import PhotoComponent from "../app/components/PhotoComponent";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-395: the phase ack says when the answering screen was painted, but the photo may still be downloading and
// decoding behind its loading indicator. QA builds also send qa-photo-shown once per round photo, when the main photo
// first draws (after the iOS fallback to the photo URL too) or can't be drawn at all, with the phase and round the game
// screen had painted. Other builds, and photos outside the game screen, never send it.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("expo-blur", () => ({ BlurView: () => null }));

const mockSocket = new FakeSocket();
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true, lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn(), resetUsedPhotos: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
const originalQa = process.env.EXPO_PUBLIC_QA;
const setQa = (value: string | undefined) => {
  if (value === undefined) delete process.env.EXPO_PUBLIC_QA;
  else process.env.EXPO_PUBLIC_QA = value;
};

const isHost = (n: ReactTestInstance) => typeof n.type === "string";
const mainPhoto = (root: ReactTestInstance) =>
  root.find((n) => typeof n.props.onLoad === "function" && n.props.resizeMode === "contain" && !isHost(n));
const photoShownAcks = () => mockSocket.emittedPayloads("qa-photo-shown");

const ROUND_START = (round: number) => ({ photo: `/temp/${round}.jpg`, round, duration: 8_000 });

let r: TestRenderer.ReactTestRenderer | null = null;
/** The game screen with its room credentials resolved (the photo is drawn only with them) */
const openGame = async () => {
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await act(async () => {});
  return r!;
};
/** Starts `round` and, on iOS, answers its single photo download (the main photo is mounted after it, EXP-394) */
const startRound = async (round: number) => {
  act(() => mockSocket.fire("waiting-photo", { round, duration: 10_000 }));
  act(() => mockSocket.fire("round-start", ROUND_START(round)));
  if (Platform.OS === "ios") {
    const request = FakeXhr.requests[FakeXhr.requests.length - 1];
    await act(async () => { request.respond(200); });
  }
};

let restoreXhr: () => void;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(() => {
  mockSocket.reset();
  jest.spyOn(Image, "getSizeWithHeaders").mockResolvedValue({ width: 1600, height: 1200 } as never);
  restoreXhr = installFakeXhr("blob:photo-1?offset=0&size=1024");
  setQa("1");
});
afterEach(() => {
  if (r) act(() => r!.unmount());
  r = null;
  restoreXhr();
  setOS(realOS);
  setQa(originalQa);
  (Image.getSizeWithHeaders as jest.Mock).mockRestore();
});
afterAll(() => jest.restoreAllMocks());

describe("qa-photo-shown (EXP-395)", () => {
  it.each(["ios", "android"] as const)("on %s is sent once per photo, when it first draws", async (os) => {
    setOS(os);
    const now = jest.spyOn(Date, "now").mockReturnValue(5_000);
    const game = await openGame();
    await startRound(1);
    expect(photoShownAcks()).toEqual([]); // painted, but the photo is not on screen yet
    now.mockReturnValue(6_200);
    act(() => mainPhoto(game.root).props.onLoad());
    act(() => mainPhoto(game.root).props.onLoad()); // a later load of the same photo
    expect(photoShownAcks()).toEqual([{ phase: "answering", round: 1, at: 6_200, platform: os }]);
    await startRound(2);
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([
      { phase: "answering", round: 1, at: 6_200, platform: os },
      { phase: "answering", round: 2, at: 6_200, platform: os },
    ]);
    now.mockRestore();
  });

  it("carries the phase painted when the photo drew: a photo still loading at the reveal says so", async () => {
    setOS("android");
    const game = await openGame();
    await startRound(1);
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "" }));
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([expect.objectContaining({ phase: "reveal", round: 1 })]);
  });

  it("on iOS, after the in-memory copy fails to draw, reports the photo URL's first draw (not the failed copy)", async () => {
    setOS("ios");
    const game = await openGame();
    await startRound(1);
    act(() => mainPhoto(game.root).props.onError()); // the copy: falls back to the photo URL
    expect(photoShownAcks()).toEqual([]);
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([{ phase: "answering", round: 1, at: expect.any(Number), platform: "ios" }]);
  });

  it.each(["ios", "android"] as const)("on %s flags a photo that can't be drawn at all, once", async (os) => {
    setOS(os);
    const game = await openGame();
    await startRound(1);
    if (os === "ios") act(() => mainPhoto(game.root).props.onError()); // the copy first, then the photo URL
    act(() => mainPhoto(game.root).props.onError());
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([
      { phase: "answering", round: 1, at: expect.any(Number), platform: os, failed: true },
    ]);
  });

  it("is not sent while offline, nor late once back", async () => {
    setOS("android");
    const game = await openGame();
    await startRound(1);
    mockSocket.connected = false;
    act(() => mainPhoto(game.root).props.onLoad());
    mockSocket.connected = true;
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([]);
  });

  it.each([undefined, "0"])("is never sent when EXPO_PUBLIC_QA is %p", async (value) => {
    setOS("android");
    setQa(value);
    const game = await openGame();
    await startRound(1);
    act(() => mainPhoto(game.root).props.onLoad());
    expect(photoShownAcks()).toEqual([]);
  });

  it("is never sent from a release bundle, even with EXPO_PUBLIC_QA=1", async () => {
    setOS("android");
    const dev = (global as { __DEV__?: boolean }).__DEV__;
    try {
      const game = await openGame();
      await startRound(1);
      (global as { __DEV__?: boolean }).__DEV__ = false;
      act(() => mainPhoto(game.root).props.onLoad());
    } finally {
      (global as { __DEV__?: boolean }).__DEV__ = dev;
    }
    expect(photoShownAcks()).toEqual([]);
  });

  /** Renders a photo viewer next to whatever is mounted, and draws its photo */
  const showInViewer = async (photoUrl: string) => {
    let viewer!: TestRenderer.ReactTestRenderer;
    await act(async () => { viewer = TestRenderer.create(<PhotoComponent photoUrl={photoUrl} />); });
    act(() => mainPhoto(viewer.root).props.onLoad());
    act(() => viewer.unmount());
  };

  it("is not sent for an on-device photo (own photos viewer), even while the game screen shows a round", async () => {
    setOS("android");
    await openGame();
    await startRound(1);
    await showInViewer("file:///gallery/own.jpg");
    expect(photoShownAcks()).toEqual([]);
  });

  it("is not sent once the game screen is gone, even for a server photo", async () => {
    setOS("android");
    const game = await openGame();
    await startRound(1);
    act(() => game.unmount());
    r = null;
    await showInViewer("http://s/temp/x.jpg");
    expect(photoShownAcks()).toEqual([]);
  });
});
