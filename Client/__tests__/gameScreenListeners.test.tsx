import React from "react";
import TestRenderer, { act } from "react-test-renderer";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-248: GameScreen removes only its own socket listeners (handler by handler, like the waiting room), never every
// listener of an event: the socket is shared, and the lobby (or a hook) listens to some of the same events.

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
  count(ev: string) { return this.handlers.get(ev)?.size ?? 0; }
}

const mockSocket = new FakeSocket();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
    setPlantedPhotoUri: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: jest.fn(async () => ({ error: "permission" })), setPhotoUri: jest.fn() }),
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

// Every event the game screen reacts to while the game runs
const GAME_SCREEN_EVENTS = [
  "waiting-photo", "your-turn", "round-start", "round-reveal", "round-scores", "hold-start", "hold-end", "hold-resume",
  "round-skipped", "game-paused", "game-resumed", "game-state", "game-over", "player-left", "player-removed",
  "new-host", "emoji-reaction",
];
// Events other components (the waiting room, hooks) may also listen to on the same socket
const SHARED_EVENTS = ["game-state", "game-started", "player-left", "player-removed", "new-host", "your-turn", "round-start"];

let foreign: Record<string, jest.Mock>;
beforeEach(() => {
  mockSocket.handlers.clear();
  mockSocket.emitted = [];
  foreign = Object.fromEntries(SHARED_EVENTS.map((ev) => [ev, jest.fn()]));
  Object.entries(foreign).forEach(([ev, fn]) => mockSocket.on(ev, fn));
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();
  return r;
};
// Listeners of the game screen itself (all of them minus the foreign one, if any)
const ownCount = (ev: string) => mockSocket.count(ev) - (foreign[ev] ? 1 : 0);
const expectOwnCounts = (events: string[], n: number) => {
  for (const ev of events) expect([ev, ownCount(ev)]).toEqual([ev, n]);
};
const expectForeignListenersKept = () => {
  for (const [ev, fn] of Object.entries(foreign)) expect([ev, mockSocket.handlers.get(ev)?.has(fn)]).toEqual([ev, true]);
};

describe("GameScreen socket listeners (EXP-248)", () => {
  it("handles every game event with exactly one listener, also after re-renders", async () => {
    const r = await mount();
    expectOwnCounts(GAME_SCREEN_EVENTS, 1);
    await act(async () => { r.update(<GameScreen />); });
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }));
    await flush();
    expectOwnCounts(GAME_SCREEN_EVENTS, 1);
    act(() => r.unmount());
  });

  it("unmounting removes only the game screen's own listeners", async () => {
    const r = await mount();
    act(() => r.unmount());
    expectOwnCounts(GAME_SCREEN_EVENTS, 0);
    expectForeignListenersKept();
  });

  it("game over drops the game listeners but not other components' ones; the final-screen ones go on unmount", async () => {
    const r = await mount();
    act(() => mockSocket.fire("game-over", { finalScore: [{ username: "bob", points: 1 }] }));
    await flush();
    expectForeignListenersKept();
    expectOwnCounts(["waiting-photo", "round-start", "round-reveal", "round-scores", "round-skipped", "emoji-reaction"], 0);
    // Final screens: next game hand-over and declining my turn at once
    expectOwnCounts(["game-started", "game-state", "your-turn"], 1);
    // Still in the room: membership changes keep being applied
    expectOwnCounts(["player-left", "player-removed", "new-host"], 1);

    act(() => r.unmount());
    expectOwnCounts([...GAME_SCREEN_EVENTS, "game-started"], 0);
    expectForeignListenersKept();
  });

  it("a snapshot of a game that ended while I was away leaves other components' listeners alone", async () => {
    const r = await mount();
    act(() => mockSocket.fire("game-state", {
      started: false, phase: null, round: 10, totalRounds: 10, photo: null, correctAnswer: null,
      duration: 0, held: false, pause: null, scores: [{ username: "bob", points: 1 }], players: [],
    }));
    await flush();
    expectForeignListenersKept();
    expectOwnCounts(["round-start", "waiting-photo"], 0);
    act(() => r.unmount());
    expectOwnCounts([...GAME_SCREEN_EVENTS, "game-started"], 0);
    expectForeignListenersKept();
  });
});
