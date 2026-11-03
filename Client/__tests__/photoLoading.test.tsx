import React from "react";
import { ActivityIndicator, Image, NativeModules, Platform } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS } from "../src/utils/testIds";
import { downloadImageToMemory, PHOTO_DOWNLOAD_STALL_TIMEOUT_MS, prefetchImage } from "../src/utils/image";
import {
  EXPO_BRIDGELESS_CREATE_OBJECT_URL_ERROR, FAKE_BLOB_URI as BLOB_URI, FakeXhr, installFakeXhr,
} from "../testUtils/fakeXhr";
import PhotoComponent from "../src/components/PhotoComponent";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";
import getEnvVars from "../config";

// EXP-119: the round photo downloads with nothing on screen (grey/black) while the answer bar already runs: it starts
// downloading as soon as its URL arrives, with the room credentials, and a loading indicator covers it until it loads.
// EXP-131: on Android the blurred backdrop requested the same photo alongside the main one and showed up 1-2 s later:
// it is drawn once the main photo has loaded, from the same source.
// EXP-394: on iOS the main photo and the backdrop each downloaded the photo (no-store responses aren't cached there):
// the photo is downloaded once into memory and both views draw that copy, the backdrop once the main photo has loaded.
// EXP-401: a stalled in-memory download settled neither way, so the loading indicator stayed up all round: it times out
// and falls back to the photo URL, like a failed download.
// EXP-404: on the device the in-memory copy was never drawn and iOS still downloaded each photo 3 times: Expo's
// URL.createObjectURL always throws on React Native's bridgeless runtime, so the download "failed" and both views loaded
// the photo URL. The blob URI is built from React Native's blob module instead.

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
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

const HEADERS = { Authorization: "Bearer tok-123", "X-Game-Code": "123456" };
const PHOTO_URL = "http://s/temp/a.jpg";
const { SERVER_URL } = getEnvVars();

const realOS = Platform.OS;
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
let getSizeWithHeaders: jest.SpyInstance;
let restoreXhr: () => void;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(() => {
  getSizeWithHeaders = jest.spyOn(Image, "getSizeWithHeaders").mockResolvedValue({ width: 1600, height: 1200 } as never);
  restoreXhr = installFakeXhr();
});
afterEach(() => {
  setOS(realOS);
  getSizeWithHeaders.mockRestore();
  restoreXhr();
});
afterAll(() => jest.restoreAllMocks());

const isHost = (n: ReactTestInstance) => typeof n.type === "string";
const loadingShown = (root: ReactTestInstance) =>
  root.findAll((n) => n.props.testID === TEST_IDS.photoLoading && isHost(n)).length > 0;
const mainPhoto = (root: ReactTestInstance) =>
  root.find((n) => typeof n.props.onLoad === "function" && n.props.resizeMode === "contain" && !isHost(n));
const backdrops = (root: ReactTestInstance) => root.findAll((n) => n.type === Image && n.props.blurRadius > 0);
// Every native image view on screen, and those that would download the photo from the server
const images = (root: ReactTestInstance) => root.findAll((n) => n.type === Image);
const serverImages = (root: ReactTestInstance) => images(root).filter((n) => n.props.source?.uri === PHOTO_URL);
const coverImages = (root: ReactTestInstance) => images(root).filter((n) => n.props.resizeMode === "cover");
/** Answers the latest photo download (PhotoComponent starts one per server photo on iOS) */
const finishDownload = async (status = 200) => {
  const request = FakeXhr.requests[FakeXhr.requests.length - 1];
  let blob!: ReturnType<FakeXhr["respond"]>;
  await act(async () => { blob = request.respond(status); });
  return blob;
};
const renderPhoto = async (photoUrl = PHOTO_URL) => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<PhotoComponent photoUrl={photoUrl} headers={HEADERS} />); });
  return r;
};

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
  // On iOS the main photo is mounted once its single download has finished (EXP-394)
  const render = async (photoUrl: string) => {
    const r = await renderPhoto(photoUrl);
    if (Platform.OS === "ios") {
      expect(loadingShown(r.root)).toBe(true); // also while it downloads
      await finishDownload();
    }
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

  it.each(["ios", "android"] as const)("on %s drops the indicator when the photo fails to load", async (os) => {
    setOS(os);
    const r = await render(PHOTO_URL);
    // iOS first retries a failed in-memory copy from the photo URL (EXP-394)
    if (os === "ios") act(() => mainPhoto(r.root).props.onError());
    act(() => mainPhoto(r.root).props.onError());
    expect(loadingShown(r.root)).toBe(false);
  });

  it.each(["ios", "android"] as const)("on %s shows it again for the next photo", async (os) => {
    setOS(os);
    const r = await render(PHOTO_URL);
    act(() => mainPhoto(r.root).props.onLoad());
    await act(async () => { r.update(<PhotoComponent photoUrl="http://s/temp/b.jpg" headers={HEADERS} />); });
    expect(loadingShown(r.root)).toBe(true);
  });
});

describe("PhotoComponent backdrop mount order (EXP-131, EXP-394)", () => {
  it.each(["ios", "android"] as const)("on %s the backdrop is drawn after the main photo loads, same source", async (os) => {
    setOS(os);
    const r = await renderPhoto();
    if (os === "ios") await finishDownload();
    expect(images(r.root)).toHaveLength(1); // only the main photo
    expect(coverImages(r.root)).toHaveLength(0);
    expect(backdrops(r.root)).toHaveLength(0);
    act(() => mainPhoto(r.root).props.onLoad());
    const backdrop = os === "ios" ? coverImages(r.root) : backdrops(r.root);
    expect(backdrop).toHaveLength(1);
    expect(backdrop[0].props.source).toBe(mainPhoto(r.root).props.source);
  });
});

describe("PhotoComponent on iOS downloads the photo once (EXP-394)", () => {
  beforeEach(() => setOS("ios"));

  it("one GET with the room credentials, and both views draw the in-memory copy", async () => {
    const r = await renderPhoto();
    expect(FakeXhr.requests).toHaveLength(1);
    expect(FakeXhr.requests[0]).toMatchObject({
      method: "GET", url: PHOTO_URL, responseType: "blob", headers: HEADERS, sent: true,
    });
    // While it downloads no view requests the photo
    expect(images(r.root)).toHaveLength(0);
    await finishDownload();
    expect(images(r.root)).toHaveLength(1);
    expect(mainPhoto(r.root).props.source).toEqual({ uri: BLOB_URI });
    act(() => mainPhoto(r.root).props.onLoad());
    expect(images(r.root)).toHaveLength(2);
    expect(coverImages(r.root)[0].props.source).toEqual({ uri: BLOB_URI });
    // No view ever loads the server URL itself: that would be a second download
    expect(serverImages(r.root)).toHaveLength(0);
    expect(FakeXhr.requests).toHaveLength(1);
  });

  it("frees the in-memory photo when the next photo replaces it, and downloads that one once", async () => {
    const r = await renderPhoto();
    const blob = await finishDownload();
    act(() => mainPhoto(r.root).props.onLoad());
    await act(async () => { r.update(<PhotoComponent photoUrl="http://s/temp/b.jpg" headers={HEADERS} />); });
    expect(blob.close).toHaveBeenCalledTimes(1);
    expect(FakeXhr.requests).toHaveLength(2);
    expect(FakeXhr.requests[1].url).toBe("http://s/temp/b.jpg");
    // The previous photo's copy is never drawn for the new one
    expect(images(r.root)).toHaveLength(0);
    expect(loadingShown(r.root)).toBe(true);
  });

  it("cancels a download still in flight when the photo changes or the view unmounts", async () => {
    const r = await renderPhoto();
    await act(async () => { r.update(<PhotoComponent photoUrl="http://s/temp/b.jpg" headers={HEADERS} />); });
    expect(FakeXhr.requests[0].aborted).toBe(true);
    act(() => r.unmount());
    expect(FakeXhr.requests[1].aborted).toBe(true);
  });

  it.each([
    ["a network error", () => act(async () => FakeXhr.requests[0].fail())],
    ["an HTTP error", () => finishDownload(403)],
    ["a stall (EXP-401)", () => act(async () => FakeXhr.requests[0].stall(PHOTO_DOWNLOAD_STALL_TIMEOUT_MS))],
  ])("after %s falls back to the photo URL, so the <Image> retries it and reports the error", async (_, failDownload) => {
    const r = await renderPhoto();
    await failDownload();
    expect(mainPhoto(r.root).props.source).toEqual({ uri: PHOTO_URL, headers: HEADERS });
    act(() => mainPhoto(r.root).props.onError());
    expect(loadingShown(r.root)).toBe(false);
  });

  it("retries from the photo URL when the downloaded copy can't be drawn, and only then reports the error", async () => {
    const r = await renderPhoto();
    await finishDownload();
    act(() => mainPhoto(r.root).props.onError());
    expect(mainPhoto(r.root).props.source).toEqual({ uri: PHOTO_URL, headers: HEADERS });
    expect(loadingShown(r.root)).toBe(true);
    act(() => mainPhoto(r.root).props.onLoad());
    expect(loadingShown(r.root)).toBe(false);
    // The backdrop draws the same source as the main photo
    expect(coverImages(r.root)[0].props.source).toBe(mainPhoto(r.root).props.source);
  });

  it("draws an on-device photo (own photos viewer) directly, without downloading it", async () => {
    const r = await renderPhoto("ph://ABC-123");
    expect(FakeXhr.requests).toHaveLength(0);
    expect(mainPhoto(r.root).props.source).toEqual({ uri: "ph://ABC-123", headers: HEADERS });
  });
});

describe("PhotoComponent on iOS costs one GET per photo (EXP-404)", () => {
  beforeEach(() => setOS("ios"));

  // Each network download of the photo: the in-memory download, plus every view drawing the photo URL itself (iOS
  // keeps no copy of the server's no-store photos, so each such view downloads it again)
  const photoGets = (root: ReactTestInstance) => FakeXhr.requests.length + serverImages(root).length;

  it("downloads the photo once for the main photo and its backdrop, in the device's blob runtime", async () => {
    const r = await renderPhoto();
    await finishDownload();
    expect(photoGets(r.root)).toBe(1);
    act(() => mainPhoto(r.root).props.onLoad());
    expect(coverImages(r.root)).toHaveLength(1); // the backdrop is drawn
    expect(photoGets(r.root)).toBe(1);
  });

  it("does not use Expo's URL.createObjectURL: it always throws on React Native's bridgeless runtime", () => {
    const runtime = globalThis as { RN$Bridgeless?: boolean; __turboModuleProxy?: unknown };
    const { RN$Bridgeless: bridgeless, __turboModuleProxy: turboModuleProxy } = runtime;
    // As on the device: React Native's bridgeless runtime defines RN$Bridgeless and never __turboModuleProxy
    runtime.RN$Bridgeless = true;
    delete runtime.__turboModuleProxy;
    try {
      let ExpoURL!: typeof URL;
      jest.isolateModules(() => { ExpoURL = require("expo/src/winter/url").URL; });
      const blob = new FakeXhr().arrive() as unknown as Blob;
      expect(() => ExpoURL.createObjectURL(blob)).toThrow(EXPO_BRIDGELESS_CREATE_OBJECT_URL_ERROR);
      // and from then on, for every photo
      expect(() => ExpoURL.createObjectURL(blob)).toThrow("Cannot create URL for blob");
    } finally {
      if (bridgeless === undefined) delete runtime.RN$Bridgeless;
      else runtime.RN$Bridgeless = bridgeless;
      if (turboModuleProxy !== undefined) runtime.__turboModuleProxy = turboModuleProxy;
    }
  });
});

describe("downloadImageToMemory (EXP-394)", () => {
  it("resolves with a blob: URI of the photo and frees it once on release", async () => {
    const download = downloadImageToMemory(PHOTO_URL, HEADERS);
    const blob = FakeXhr.requests[0].respond();
    await expect(download.uri).resolves.toBe(BLOB_URI);
    // Never through Expo's URL.createObjectURL, which always throws on the device (EXP-404)
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    download.release();
    download.release();
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  it("rejects on an HTTP error and frees the error response's blob", async () => {
    const download = downloadImageToMemory(PHOTO_URL, HEADERS);
    const blob = FakeXhr.requests[0].respond(403);
    await expect(download.uri).rejects.toThrow("HTTP 403");
    expect(blob.close).toHaveBeenCalledTimes(1);
    download.release();
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  it("released once the response has arrived, lets it finish and frees its blob (an abort would leak it)", async () => {
    const download = downloadImageToMemory(PHOTO_URL, HEADERS);
    const request = FakeXhr.requests[0];
    const blob = request.arrive();
    download.release();
    expect(request.aborted).toBe(false);
    request.respond();
    await expect(download.uri).rejects.toThrow("released");
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  it("rejects and frees the photo when no blob: URI can be made for it", async () => {
    jest.spyOn(NativeModules.BlobModule, "getConstants").mockReturnValue({});
    const download = downloadImageToMemory(PHOTO_URL, HEADERS);
    const blob = FakeXhr.requests[0].respond();
    await expect(download.uri).rejects.toThrow("Cannot create URL");
    expect(blob.close).toHaveBeenCalledTimes(1);
    download.release();
    expect(blob.close).toHaveBeenCalledTimes(1);
  });

  it("times out once the network sends nothing for the stall timeout, leaving time to retry in the round (EXP-401)", async () => {
    const download = downloadImageToMemory(PHOTO_URL, HEADERS);
    const request = FakeXhr.requests[0];
    request.stall(PHOTO_DOWNLOAD_STALL_TIMEOUT_MS - 1);
    request.stall(PHOTO_DOWNLOAD_STALL_TIMEOUT_MS);
    await expect(download.uri).rejects.toThrow("Photo download failed");
    // Under half of the 7.7 s answer bar: the photo URL fallback still has most of the round to load
    expect(PHOTO_DOWNLOAD_STALL_TIMEOUT_MS).toBeLessThanOrEqual(7_700 / 2);
    // Nothing to free or cancel: a timed-out request has no blob and has already ended
    download.release();
    expect(request.aborted).toBe(false);
  });

  it("aborts a download released before it finishes", async () => {
    const download = downloadImageToMemory(PHOTO_URL);
    download.release();
    expect(FakeXhr.requests[0].aborted).toBe(true);
    await expect(download.uri).rejects.toThrow();
  });

  it("never throws, even without a native XMLHttpRequest", async () => {
    const fakeXhr = globalThis.XMLHttpRequest;
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = undefined;
    try {
      const download = downloadImageToMemory(PHOTO_URL);
      await expect(download.uri).rejects.toThrow();
      expect(() => download.release()).not.toThrow();
    } finally {
      globalThis.XMLHttpRequest = fakeXhr;
    }
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
    act(() => mockSocket.fire("round-reveal", { correctAnswer: "alice", duration: 3_000, yourGuess: "" }));
    expect(getSizeWithHeaders).toHaveBeenCalledTimes(1);
  });

  it("on a game-state snapshot of a round in play", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "answering", round: 2, photo: "/temp/2.jpg", duration: 5_000, held: false,
      totalRounds: 10, pause: null, players: mockPlayers, roundOptions: mockPlayers, scores: [], correctAnswer: null,
    }));
    expect(getSizeWithHeaders).toHaveBeenCalledWith(`${SERVER_URL}/temp/2.jpg`, HEADERS);
  });
});
