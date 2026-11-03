import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { AppState } from "react-native";
import GameScreen from "../app/screens/GameScreen";

// EXP-172: game over does not end the socket. The player stays connected (and in the room) through the winner and
// final screens; "Play again" reuses the same socket. The finished game screen must also stop reacting to game
// events: a next game started meanwhile must not drive it (e.g. a your-turn picking a photo behind the modal).

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockReplace = jest.fn();
const mockEndSocket = jest.fn();
const mockSetPlanted = jest.fn();
const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockWinnerProps: { visible?: boolean }[] = [];
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: mockEndSocket,
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    setPlantedPhotoUri: mockSetPlanted, takeInviteOverRoomScreen: () => null,
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    pickGamePhoto: (...a: unknown[]) => mockPickGamePhoto(...a), setPhotoUri: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("@/src/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => (props: { visible?: boolean }) => { mockWinnerProps.push(props); return null; });
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  mockEndSocket.mockClear();
  mockReplace.mockClear();
  mockSetPlanted.mockClear();
  mockSocket.disconnect.mockClear();
  mockPickGamePhoto.mockReset();
  mockWinnerProps.length = 0;
  mockSocket.emitted = [];
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const finalScore = [{ username: "bob", points: 3 }, { username: "ana", points: 1 }];

async function mountAndEndGame() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();
  act(() => mockSocket.fire("game-over", { finalScore }));
  await flush();
  return r;
}

describe("GameScreen at game over (EXP-172)", () => {
  it("shows the winner screen without ending or disconnecting the socket", async () => {
    const r = await mountAndEndGame();
    expect(mockWinnerProps[mockWinnerProps.length - 1].visible).toBe(true);
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("leaving the game screen (Play again -> lobby) keeps the socket for the lobby to reuse", async () => {
    const r = await mountAndEndGame();
    act(() => r.unmount());
    expect(mockEndSocket).not.toHaveBeenCalled();
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
  });

  it("a next game started meanwhile does not drive the finished screen; my turn is declined at once", async () => {
    const r = await mountAndEndGame();
    mockSocket.emitted = []; // im-ready of the finished game
    act(() => {
      mockSocket.fire("waiting-photo", { round: 1, duration: 20000 });
      mockSocket.fire("your-turn", { round: 1, attempt: 7 });
    });
    await flush();
    // Never a gallery pick behind the modal, but the server is told right away so nobody waits 15 s for me
    expect(mockPickGamePhoto).not.toHaveBeenCalled();
    expect(mockSocket.emitted).toEqual([["photo-unavailable", { round: 1, attempt: 7 }]]);
    expect(mockSocket.handlers.get("round-start")?.size ?? 0).toBe(0);
    expect(mockSocket.handlers.get("waiting-photo")?.size ?? 0).toBe(0);
    expect(mockSocket.handlers.get("your-turn")?.size).toBe(1);
    act(() => r.unmount());
    expect(mockSocket.handlers.get("your-turn")?.size ?? 0).toBe(0);
  });
});

// EXP-184 (DEC-018 A): a player still on the final screens is taken into the next game as soon as the host starts it,
// through the same path as "Play again" (lobby rejoin on this socket -> snapshot -> fresh game screen -> im-ready)
describe("GameScreen final screens when the next game starts (EXP-184)", () => {
  it("game-started takes me to the lobby hand-over at once, once, dropping the old planted photo", async () => {
    const r = await mountAndEndGame();
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => {
      mockSocket.fire("game-started", [{ username: "bob" }, { username: "ana" }], 10);
      mockSocket.fire("game-started", [{ username: "bob" }, { username: "ana" }], 10);
    });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(mockSetPlanted).toHaveBeenCalledWith(null);
    expect(mockEndSocket).not.toHaveBeenCalled();
    act(() => r.unmount());
    expect(mockSocket.handlers.get("game-started")?.size ?? 0).toBe(0);
    expect(mockSocket.handlers.get("game-state")?.size ?? 0).toBe(0);
  });

  it("a snapshot of a started game (reconnected while on the final screens) also joins the next game", async () => {
    const r = await mountAndEndGame();
    act(() => mockSocket.fire("game-state", { started: false, phase: null, scores: finalScore, players: [] }));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => mockSocket.fire("game-state", { started: true, phase: null, round: 0, totalRounds: 10, scores: [], players: [] }));
    expect(mockReplace).toHaveBeenCalledWith("/screens/WaitingRoom");
    act(() => r.unmount());
  });

  it("game-started during the game itself (never sent by the server then) does not navigate", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await flush();
    act(() => mockSocket.fire("game-started", [], 10));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

// EXP-302 / EXP-318: my socket was down when the game ended (game-over lost) and the host started the next game before
// I came back. The rejoin's snapshot is of that new game (the room's next game number): this screen hands over to it
// like the final screens do, instead of playing it on with the old game's used photos and round count.
describe("GameScreen when the rejoin snapshot is of the next game (EXP-302, EXP-318)", () => {
  const roundScores = (round: number, totalRounds: number) => ({ scores: finalScore, round, totalRounds, duration: 5000 });
  const newGame = {
    started: true, gameNumber: 2, phase: null, round: 0, totalRounds: 10, photo: null, correctAnswer: null,
    yourGuess: null, duration: 0, phaseTotal: 0, held: false, pause: null, scores: [], players: [], roundOptions: [],
  };
  const waitingSnapshot = (round: number, totalRounds: number, gameNumber = 2) =>
    ({ ...newGame, gameNumber, phase: "waiting-photo", round, totalRounds, duration: 9000, phaseTotal: 15000 });
  const texts = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => typeof n.type === "string" && n.props.children !== undefined).map((n) => n.props.children).flat();

  /** Game 1 on screen, at its first photo wait */
  async function mountAtFirstWait() {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await flush();
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15000, gameNumber: 1 }));
    mockSocket.emitted = [];
    return r;
  }

  /** Game 1 on screen, at its last scores */
  async function mountAtLastScores() {
    const r = await mountAtFirstWait();
    act(() => {
      mockSocket.fire("round-start", { photo: "/temp/9-z.jpg", round: 10, duration: 7700 });
      mockSocket.fire("round-scores", roundScores(10, 10));
    });
    mockSocket.emitted = [];
    return r;
  }

  // What the round-progress heuristic could not tell (EXP-318): game 1 ended early and game 2, with the same number of
  // rounds, is at the very photo wait where game 1 stopped
  it("joins the next game also when it is at the point where this one ended early", async () => {
    const r = await mountAtFirstWait();
    act(() => mockSocket.fire("game-state", waitingSnapshot(0, 10)));
    expect(mockReplace).toHaveBeenCalledWith("/screens/WaitingRoom");
    act(() => r.unmount());
  });

  it("a snapshot of this game's photo wait does not leave it", async () => {
    const r = await mountAtFirstWait();
    act(() => mockSocket.fire("game-state", waitingSnapshot(0, 10, 1)));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(texts(r)).toContain("Round 1 of 10");
    act(() => r.unmount());
  });

  it("joins the next game through the lobby at once, and stops driving this one", async () => {
    const r = await mountAtLastScores();
    act(() => mockSocket.fire("game-state", newGame));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(mockSetPlanted).toHaveBeenCalledWith(null);
    // Not the new game's im-ready from here: the fresh game screen sends it
    expect(mockSocket.emitted).toEqual([]);
    // A your-turn of the new game right after the snapshot is left to the fresh screen (asked again on its rejoin)
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    expect(mockPickGamePhoto).not.toHaveBeenCalled();
    expect(mockSocket.emitted).toEqual([]);
    expect(mockSocket.handlers.get("waiting-photo")?.size ?? 0).toBe(0);
    act(() => r.unmount());
  });

  it("a snapshot of this game going on does not leave it", async () => {
    const r = await mountAtLastScores();
    act(() => mockSocket.fire("game-state", { ...newGame, gameNumber: 1, phase: "scores", round: 10, photo: "/temp/9-z.jpg", scores: finalScore }));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("shows the server's number of rounds, not the lobby's", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await flush();
    act(() => mockSocket.fire("game-state", waitingSnapshot(3, 15))); // the lobby said 10
    expect(texts(r)).toContain("Round 4 of 15");
    act(() => r.unmount());
  });
});
