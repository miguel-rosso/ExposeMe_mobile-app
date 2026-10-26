import React from "react";
import { ActivityIndicator, Image, Platform } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { TEST_IDS } from "../app/utils/testIds";
import { prefetchImage } from "../app/utils/image";
import PhotoComponent from "../app/components/PhotoComponent";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import getEnvVars from "../config";

// EXP-119: the round photo downloads with nothing on screen (grey/black) while the answer bar already runs: it starts
// downloading as soon as its URL arrives, with the room credentials, and a loading indicator covers it until it loads.
// EXP-131: on Android the blurred backdrop requested the same photo alongside the main one and showed up 1-2 s later:
// it is drawn once the main photo has loaded, from the same source.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("expo-blur", () => ({ BlurView: () => null }));

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
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

const HEADERS = { Authorization: "Bearer tok-123", "X-Game-Code": "123456" };
const PHOTO_URL = "http://s/temp/a.jpg";
const { SERVER_URL } = getEnvVars();

const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
let getSizeWithHeaders: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(() => {
  getSizeWithHeaders = jest.spyOn(Image, "getSizeWithHeaders").mockResolvedValue({ width: 1600, height: 1200 } as never);
});
afterEach(() => {
  setOS(realOS);
  getSizeWithHeaders.mockRestore();
});
afterAll(() => jest.restoreAllMocks());

const isHost = (n: ReactTestInstance) => typeof n.type === "string";
const loadingShown = (root: ReactTestInstance) =>
  root.findAll((n) => n.props.testID === TEST_IDS.photoLoading && isHost(n)).length > 0;
const mainPhoto = (root: ReactTestInstance) =>
  root.find((n) => typeof n.props.onLoad === "function" && n.props.resizeMode === "contain" && !isHost(n));
const backdrops = (root: ReactTestInstance) => root.findAll((n) => n.type === Image && n.props.blurRadius > 0);

describe("prefetchImage (EXP-119)", () => {
  it("on Android fetches the photo into the image cache with the request headers", async () => {
    setOS("android");
    prefetchImage(PHOTO_URL, HEADERS);
    expect(getSizeWithHeaders).toHaveBeenCalledWith(PHOTO_URL, HEADERS);
  });

  it("ignores a failed prefetch: the <Image> loads the photo anyway", async () => {
    setOS("android");
    getSizeWithHeaders.mockRejectedValue(new Error("403"));
    expect(() => prefetchImage(PHOTO_URL, HEADERS)).not.toThrow();
    await act(async () => {}); // the rejection is handled: no unhandled promise rejection
    getSizeWithHeaders.mockImplementation(() => { throw new Error("no native image loader"); });
    expect(() => prefetchImage(PHOTO_URL, HEADERS)).not.toThrow();
  });

  it("does nothing on iOS (the server's no-store photos can't be cached there)", () => {
    setOS("ios");
    prefetchImage(PHOTO_URL, HEADERS);
    expect(getSizeWithHeaders).not.toHaveBeenCalled();
  });
});

describe("PhotoComponent loading indicator (EXP-119)", () => {
  const render = async (photoUrl: string) => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl={photoUrl} headers={HEADERS} />); });
    return r;
  };

  it.each(["ios", "android"] as const)("on %s shows the indicator until the photo loads", async (os) => {
    setOS(os);
    const r = await render(PHOTO_URL);
    expect(loadingShown(r.root)).toBe(true);
    expect(r.root.findAll((n) => n.type === ActivityIndicator)).toHaveLength(1);
    act(() => mainPhoto(r.root).props.onLoad());
    expect(loadingShown(r.root)).toBe(false);
  });

  it("drops the indicator when the photo fails to load (no endless spinner)", async () => {
    const r = await render(PHOTO_URL);
    act(() => mainPhoto(r.root).props.onError());
    expect(loadingShown(r.root)).toBe(false);
  });

  it("shows it again for the next photo", async () => {
    const r = await render(PHOTO_URL);
    act(() => mainPhoto(r.root).props.onLoad());
    await act(async () => { r.update(<PhotoComponent photoUrl="http://s/temp/b.jpg" headers={HEADERS} />); });
    expect(loadingShown(r.root)).toBe(true);
  });
});

describe("PhotoComponent Android backdrop (EXP-131)", () => {
  it("is drawn once the main photo has loaded, from the same source", async () => {
    setOS("android");
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl={PHOTO_URL} headers={HEADERS} />); });
    expect(backdrops(r.root)).toHaveLength(0);
    act(() => mainPhoto(r.root).props.onLoad());
    const [backdrop] = backdrops(r.root);
    expect(backdrop).toBeDefined();
    expect(backdrop.props.source).toBe(mainPhoto(r.root).props.source);
    expect(backdrop.props.source).toEqual({ uri: PHOTO_URL, headers: HEADERS });
  });
});

describe("GameScreen prefetches the round photo (EXP-119)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    setOS("android");
    mockSocket.handlers.clear();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await act(async () => {}); // the room credentials (async) resolve before the round
  });
  afterEach(() => act(() => r.unmount()));

  it("on round-start, with the room credentials, once per photo", () => {
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 10_000 }));
    expect(getSizeWithHeaders).not.toHaveBeenCalled();
    act(() => mockSocket.fire("round-start", { photo: "/temp/1.jpg", round: 1, duration: 8_000 }));
    expect(getSizeWithHeaders).toHaveBeenCalledTimes(1);
    expect(getSizeWithHeaders).toHaveBeenCalledWith(`${SERVER_URL}/temp/1.jpg`, HEADERS);
    // Same photo through the rest of the round: no new download
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000 }));
    expect(getSizeWithHeaders).toHaveBeenCalledTimes(1);
  });

  it("on a game-state snapshot of a round in play", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 2, photo: "/temp/2.jpg", duration: 5_000, held: false,
      totalRounds: 10, pause: null, players: mockPlayers, scores: [], correctAnswer: null,
    }));
    expect(getSizeWithHeaders).toHaveBeenCalledWith(`${SERVER_URL}/temp/2.jpg`, HEADERS);
  });
});
