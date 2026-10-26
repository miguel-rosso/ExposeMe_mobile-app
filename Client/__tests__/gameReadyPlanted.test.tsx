import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-126: the game screen sends im-ready at once. The planted photo is uploaded from the lobby; only when that
// failed does the game screen retry it, and only after im-ready, so nobody can tell the planter by who is ready last.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
// Planted photo picked in the lobby; `sent` = the lobby upload went through
const mockPlanted = { uri: null as string | null, sent: false };
// Records when the retry ran relative to im-ready
const mockPlantPhoto = jest.fn(async () => { mockSocket.emitted.push(["(plant retry)"]); return true; });
const mockPlayers = ["alice", "bob", "carol"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
// Stateful players list, like GameContext's useState (functional updates included)
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => {
    const [playersProvider, setPlayersProvider] = require("react").useState(mockPlayers);
    return {
      username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
      playersProvider, setPlayersProvider, roundsOfGame: 10, plantedPhotoUri: mockPlanted.uri,
      plantedPhotoSent: mockPlanted.sent, plantPhoto: mockPlantPhoto, getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    };
  },
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(), setPhotoUri: jest.fn() }),
}));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
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
beforeEach(() => { jest.useFakeTimers(); mockSocket.emitted = []; mockPlantPhoto.mockClear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  return r;
};
const sent = () => mockSocket.emitted.map(([ev]) => ev);

describe("GameScreen: im-ready never waits for a planted photo", () => {
  it("planted photo already sent from the lobby: im-ready only, no upload", async () => {
    Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: true });
    const r = await mount();
    expect(sent()).toContain("im-ready");
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("lobby upload failed: im-ready first, then the retry", async () => {
    Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: false });
    const r = await mount();
    expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
    expect(sent().indexOf("im-ready")).toBeGreaterThanOrEqual(0);
    expect(sent().indexOf("im-ready")).toBeLessThan(sent().indexOf("(plant retry)"));
    act(() => r.unmount());
  });

  // EXP-277: the planted photo sent offline (or before the rejoin bound the new socket) is planted again on the rejoin
  describe("after an in-game rejoin", () => {
    const rejoin = (room: { phase: string | null; round: number; started?: boolean }, hasPlantedPhoto: boolean) =>
      act(() => mockSocket.fire("room-of-game", {
        success: true, rejoinToken: "tok-123", hasPlantedPhoto,
        room: { gameCode: "123456", rounds: 10, started: true, players: mockPlayers, ...room },
      }));

    it("the server lacks it (not sent): plants it again", async () => {
      Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: false });
      const r = await mount();
      mockPlantPhoto.mockClear(); // the retry after im-ready
      rejoin({ phase: null, round: 0 }, false);
      expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
      act(() => r.unmount());
    });

    it("the server already has it: nothing", async () => {
      Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: false });
      const r = await mount();
      mockPlantPhoto.mockClear();
      rejoin({ phase: null, round: 0 }, true);
      expect(mockPlantPhoto).not.toHaveBeenCalled();
      act(() => r.unmount());
    });

    // Review of EXP-277: game over clears every mark and leaves no phase; the final screens keep this listener
    it("on the final screens after game over: nothing (this game's photo is not the next one's)", async () => {
      Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: true });
      const r = await mount();
      act(() => mockSocket.fire("game-over", { finalScore: [] }));
      mockPlantPhoto.mockClear();
      rejoin({ phase: null, round: 0, started: false }, false);
      expect(mockPlantPhoto).not.toHaveBeenCalled();
      Object.assign(mockPlanted, { sent: false });
      rejoin({ phase: null, round: 0, started: false }, false);
      expect(mockPlantPhoto).not.toHaveBeenCalled();
      act(() => r.unmount());
    });

    it("round 1 already played: nothing", async () => {
      Object.assign(mockPlanted, { uri: "file:///picked.jpg", sent: false });
      const r = await mount();
      mockPlantPhoto.mockClear();
      rejoin({ phase: "answering", round: 0 }, false);
      expect(mockPlantPhoto).not.toHaveBeenCalled();
      act(() => r.unmount());
    });
  });

  it("nothing planted: im-ready only", async () => {
    Object.assign(mockPlanted, { uri: null, sent: false });
    const r = await mount();
    expect(sent()).toContain("im-ready");
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
