import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-342: leaving the game (Exit on the final screens, removed, room gone) forgets the room in GameContext while the
// game screen is still mounted for its exit transition. With no room there is no session to load room photos with:
// the screen must not warn about a missing session token then.
// EXP-369: an invite link's Join from the game switches GameContext to the linked room while the game screen is still
// on its way out: that room's session does not exist yet, and is not this screen's to look up, nor to upload with.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = new FakeSocket();
/** The context's socket: the linked room's own once its lobby opened one */
let mockCurrentSocket: FakeSocket = mockSocket;
const mockPlayers = ["alice", "bob"].map((username) => ({
  username, points: 0, isHost: username === "alice", connected: true,
  lastGuess: "", lastAnswerCorrect: false,
}));
const MY_ROOM = "123456";
const LINKED_ROOM = "654321";
let mockGameCode: string | null = MY_ROOM;
/** Rejoin tokens by room: the linked room's lobby may already have stored one */
let mockTokens: Record<string, string> = {};
const mockPickGamePhoto = jest.fn();
const mockUploadPhoto = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: mockGameCode, socket: mockCurrentSocket, endSocket: jest.fn(),
    playersProvider: mockPlayers, setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async (gameCode: string) => mockTokens[gameCode] ?? null, saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: (...a: unknown[]) => mockPickGamePhoto(...a), setPhotoUri: jest.fn() }),
}));
jest.mock("@/src/utils/uploadPhoto", () => ({ uploadPhoto: (...a: unknown[]) => mockUploadPhoto(...a) }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ blocked: null, check: jest.fn(), selectMore: jest.fn() }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/components/PhotoComponent", () => () => null);
jest.mock("@/src/components/modals/ScoreModal", () => () => null);
jest.mock("@/src/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/src/components/modals/WinnerModal", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/src/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/src/components/ProgressBar", () => () => null);

let warn!: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const sessionWarnings = () =>
  warn.mock.calls.filter(([message]) => String(message).includes("no session token"));

/**
 * The game screen of MY_ROOM, then GameContext moves to `nextGameCode` (and to `nextSocket`, if given) while the screen
 * is still mounted.
 */
const renderThenSwitchRoom = async (nextGameCode: string | null, nextSocket?: FakeSocket) => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();

  mockGameCode = nextGameCode;
  if (nextSocket) mockCurrentSocket = nextSocket;
  await act(async () => { r.update(<GameScreen />); });
  await flush();
  return r;
};

describe("GameScreen once GameContext is no longer on its room", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGameCode = MY_ROOM;
    mockCurrentSocket = mockSocket;
    mockTokens = { [MY_ROOM]: "tok-123" };
    mockPickGamePhoto.mockReset().mockResolvedValue({ uri: "file:///turn.jpg" });
    mockUploadPhoto.mockReset().mockResolvedValue("/temp/turn.jpg");
    mockSocket.removeAllListeners();
    warn.mockClear();
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("the room forgotten (EXP-342): does not warn about a missing session token", async () => {
    const r = await renderThenSwitchRoom(null); // left: GameContext forgot the room, the screen is on its way out

    expect(sessionWarnings()).toHaveLength(0);
    act(() => r.unmount());
  });

  it("an invite link's Join switched to another room (EXP-369): does not look up that room's session", async () => {
    const r = await renderThenSwitchRoom(LINKED_ROOM); // its lobby has not received a session token yet

    expect(sessionWarnings()).toHaveLength(0);
    act(() => r.unmount());
  });

  // The screen binds its listeners to whichever socket the context holds: one that outlives the Join (e.g. still on its
  // way out when the linked room's socket appears) must not upload with the linked room's session
  it("an invite link's Join switched to another room (EXP-369): never uploads a turn photo with that room's session", async () => {
    mockTokens = { [LINKED_ROOM]: "tok-linked" }; // Join forgot this room's token; the linked lobby stored its own
    const linkedSocket = new FakeSocket();
    const r = await renderThenSwitchRoom(LINKED_ROOM, linkedSocket);

    await act(async () => { linkedSocket.fire("waiting-photo", { round: 2, duration: 15000 }); });
    await act(async () => { linkedSocket.fire("your-turn", { round: 2, attempt: 1 }); });
    await flush();

    const uploadedWith = mockUploadPhoto.mock.calls.map(([, , auth]) => auth);
    expect(uploadedWith).not.toContainEqual(expect.objectContaining({ gameCode: LINKED_ROOM }));
    act(() => r.unmount());
  });

  it("still in its own room: uploads the turn photo with that room's session", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    await flush();

    await act(async () => { mockSocket.fire("waiting-photo", { round: 2, duration: 15000 }); });
    await act(async () => { mockSocket.fire("your-turn", { round: 2, attempt: 1 }); });
    await flush();

    expect(mockUploadPhoto).toHaveBeenCalledWith(expect.any(String), "file:///turn.jpg", { gameCode: MY_ROOM, token: "tok-123" });
    act(() => r.unmount());
  });
});
