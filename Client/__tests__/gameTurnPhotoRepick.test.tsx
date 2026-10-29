import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { PhotoConversionError } from "../app/utils/uploadRetry";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-292: on my turn, a photo that can't be converted no longer skips the round: GameScreen picks another photo
// from the gallery and sends it, within the server's photo wait; only after a few such photos is it reported.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockUploadPhoto = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    pickGamePhoto: (...a: unknown[]) => mockPickGamePhoto(...a), setPhotoUri: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: (...a: unknown[]) => mockUploadPhoto(...a) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  mockPickGamePhoto.mockReset();
  mockUploadPhoto.mockReset();
  mockSocket.emitted = [];
});
// Unmounted even when a test fails: a screen left mounted would answer the next test's your-turn too
let screen: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => { if (screen) act(() => screen!.unmount()); screen = null; });

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const unconvertible = () => new PhotoConversionError(new Error("unsupported format"));

async function myTurn() {
  await act(async () => { screen = TestRenderer.create(<GameScreen />); });
  await flush();
  await act(async () => { mockSocket.fire("waiting-photo", { round: 2, duration: 15000 }); });
  await act(async () => { mockSocket.fire("your-turn", { round: 2, attempt: 1 }); });
  await flush();
}

describe("GameScreen my turn with an unconvertible photo (EXP-292)", () => {
  it("picks another photo and sends it instead of reporting photo-unavailable", async () => {
    mockPickGamePhoto.mockResolvedValueOnce({ uri: "file:///bad.heic" }).mockResolvedValueOnce({ uri: "file:///ok.jpg" });
    mockUploadPhoto.mockRejectedValueOnce(unconvertible()).mockResolvedValueOnce("/temp/ok.jpg");
    await myTurn();
    expect(mockPickGamePhoto).toHaveBeenCalledTimes(2);
    expect(mockSocket.emitted).toContainEqual(["photo-sent", { photo: "/temp/ok.jpg" }]);
    expect(mockSocket.emitted.some(([event]) => event === "photo-unavailable")).toBe(false);
  });

  it("reports photo-unavailable only after several unconvertible photos", async () => {
    let n = 0;
    mockPickGamePhoto.mockImplementation(async () => ({ uri: `file:///bad-${++n}.heic` }));
    mockUploadPhoto.mockRejectedValue(unconvertible());
    await myTurn();
    expect(mockPickGamePhoto.mock.calls.length).toBeGreaterThan(1);
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 2, attempt: 1 }]);
  });

  // The server's photo wait is frozen while the game is paused: a pause longer than what was left of it doesn't stop
  // the re-pick once the game resumes with the rest of the wait
  it("a pause during the conversion, longer than the wait left: after the resume the photo is still replaced", async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    let failConversion!: () => void;
    mockPickGamePhoto.mockResolvedValueOnce({ uri: "file:///bad.heic" }).mockResolvedValueOnce({ uri: "file:///ok.jpg" });
    mockUploadPhoto
      .mockImplementationOnce(() => new Promise((_, reject) => { failConversion = () => reject(unconvertible()); }))
      .mockResolvedValueOnce("/temp/ok.jpg");
    try {
      await myTurn();
      now += 5_000;
      await act(async () => {
        mockSocket.fire("game-paused", { duration: 60_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 });
      });
      now += 30_000;
      await act(async () => {
        mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 10_000, phaseTotal: 15_000 });
      });
      await act(async () => { mockSocket.fire("your-turn", { round: 2, attempt: 1 }); });
      await act(async () => { failConversion(); });
      await flush();
      expect(mockPickGamePhoto).toHaveBeenCalledTimes(2);
      expect(mockSocket.emitted).toContainEqual(["photo-sent", { photo: "/temp/ok.jpg" }]);
      expect(mockSocket.emitted.some(([event]) => event === "photo-unavailable")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});
