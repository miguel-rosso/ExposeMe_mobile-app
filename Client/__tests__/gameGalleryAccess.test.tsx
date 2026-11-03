import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { AppState } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-118: photo access revoked (or no photos left) while in a game → blocking overlay inside GameScreen, re-checked
// on every return to the foreground. The game screen stays mounted and the socket open; the overlay clears itself.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockReplace = jest.fn();
const mockEndSocket = jest.fn();
const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockCheckGalleryAccess = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: mockEndSocket,
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    pickGamePhoto: mockPickGamePhoto, setPhotoUri: jest.fn(),
    checkGalleryAccess: (...a: unknown[]) => mockCheckGalleryAccess(...a), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: jest.fn() }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => () => null);

const OK = { status: "ok", limited: false, canAskAgain: true };
const DENIED = { status: "denied", limited: false, canAskAgain: false };
const NO_PHOTOS_LIMITED = { status: "no-photos", limited: true, canAskAgain: true };

let appStateHandlers: ((s: string) => void)[] = [];
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return { remove: () => { appStateHandlers = appStateHandlers.filter((x) => x !== h); } };
  }) as typeof AppState.addEventListener);
  mockReplace.mockClear();
  mockEndSocket.mockClear();
  mockCheckGalleryAccess.mockReset();
  mockPickGamePhoto.mockReset();
  mockSocket.emitted = [];
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const foreground = async () => {
  act(() => appStateHandlers.forEach((h) => h("active")));
  await flush();
};

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GameScreen />); });
  await flush();
  return r;
}

describe("GameScreen gallery access guard (EXP-118)", () => {
  it("permission revoked while away: blocking overlay on foreground, cleared once it is back, game never left", async () => {
    mockCheckGalleryAccess.mockResolvedValue(OK);
    const r = await mount();
    expect(mockCheckGalleryAccess).toHaveBeenCalledWith({ ask: false });
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);

    mockCheckGalleryAccess.mockResolvedValue(DENIED);
    await foreground();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    expect(has(r.root, TEST_IDS.gallerySettingsButton)).toBe(true);
    // No way to dismiss it: only access coming back clears it. Its only other way out is leaving the game, which asks
    // first (EXP-377, see gameLeaveMidGame.test.tsx)
    expect(has(r.root, TEST_IDS.galleryBackButton)).toBe(true);
    expect(has(r.root, TEST_IDS.leaveGameConfirm)).toBe(false);
    // Still the game screen, still in the room
    expect(has(r.root, TEST_IDS.gameWaitingReady)).toBe(true);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockEndSocket).not.toHaveBeenCalled();
    // Prompts are never shown on a foreground re-check
    expect(mockCheckGalleryAccess.mock.calls.every(([o]) => o.ask === false)).toBe(true);

    mockCheckGalleryAccess.mockResolvedValue(OK);
    await foreground();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockEndSocket).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("limited access with no photo left: overlay offers to select photos", async () => {
    mockCheckGalleryAccess.mockResolvedValue(NO_PHOTOS_LIMITED);
    const r = await mount();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    expect(has(r.root, TEST_IDS.gallerySelectPhotosButton)).toBe(true);
    act(() => r.unmount());
  });

  it("hidden once the game is over, so the blocked player sees the winner / final scores", async () => {
    mockCheckGalleryAccess.mockResolvedValue(DENIED);
    const r = await mount();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    await act(async () => { mockSocket.fire("game-over", { finalScore: [{ username: "bob", points: 3 }] }); });
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
  });

  it("while blocked, its turn is still skipped at once (photo-unavailable)", async () => {
    mockCheckGalleryAccess.mockResolvedValue(DENIED);
    mockPickGamePhoto.mockResolvedValue({ error: "permission" });
    const r = await mount();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    await act(async () => { mockSocket.fire("waiting-photo", { round: 2, duration: 15000 }); });
    await act(async () => { mockSocket.fire("your-turn", { round: 2, attempt: 1 }); });
    await flush();
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 2, attempt: 1 }]);
    act(() => r.unmount());
  });
});
