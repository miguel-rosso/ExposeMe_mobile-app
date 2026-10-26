import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AppState } from "react-native";
import GameScreen from "../app/screens/GameScreen";

// EXP-172: game over does not end the socket. The player stays connected (and in the room) through the winner and
// final screens; "Play again" reuses the same socket. The finished game screen must also stop reacting to game
// events: a next game started meanwhile must not drive it (e.g. a your-turn picking a photo behind the modal).

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
  emit(ev: string, ...args: any[]) { this.emitted.push([ev, ...args]); return this; }
  fire(ev: string, ...args: any[]) { [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args)); }
}

const mockReplace = jest.fn();
const mockEndSocket = jest.fn();
const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockWinnerProps: { visible?: boolean }[] = [];
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: mockEndSocket,
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    pickGamePhoto: (...a: unknown[]) => mockPickGamePhoto(...a), setPhotoUri: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => (props: { visible?: boolean }) => { mockWinnerProps.push(props); return null; });
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: () => {} })) as unknown as typeof AppState.addEventListener);
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  mockEndSocket.mockClear();
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
    expect(mockSocket.handlers.has("round-start")).toBe(false);
    expect(mockSocket.handlers.has("waiting-photo")).toBe(false);
    expect(mockSocket.handlers.get("your-turn")?.size).toBe(1);
    act(() => r.unmount());
    expect(mockSocket.handlers.has("your-turn")).toBe(false);
  });
});
