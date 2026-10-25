import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { applyWaitingPhoto, skipNoticeFor, skipNoticeText } from "../app/utils/waitingPhoto";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
import es from "../app/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-039 / EXP-040 / EXP-041: the waiting screen while the server awaits the chosen player's photo, the owner's
// photo-unavailable report (no access / no photos / upload failed) and never leaving the game for a permission.

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
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
}

const mockReplace = jest.fn();
const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockUploadPhoto = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }), useFocusEffect: () => {} }));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "bob", gameCode: "123456", socket: mockSocket, endSocket: jest.fn(),
    playersProvider: [], setPlayersProvider: jest.fn(), roundsOfGame: 10, plantedPhotoUri: null,
    plantedPhotoSent: false, plantPhoto: jest.fn(), getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({ pickGamePhoto: mockPickGamePhoto, setPhotoUri: jest.fn() }),
}));
jest.mock("@/app/utils/uploadPhoto", () => ({ uploadPhoto: (...a: unknown[]) => mockUploadPhoto(...a) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
const mockPhotoProps: { photoUrl: string; headers?: Record<string, string> }[] = [];
jest.mock("@/app/components/PhotoComponent", () => (p: { photoUrl: string; headers?: Record<string, string> }) => {
  mockPhotoProps.push(p);
  return null;
});
jest.mock("@/app/components/modals/ScoreModal", () => () => null);
jest.mock("@/app/components/modals/FinalScoreModal", () => () => null);
jest.mock("@/app/components/modals/WinnerModal", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojiReaction", () => () => null);
jest.mock("@/app/components/IngameComunication/EmojisButtons", () => () => null);
jest.mock("@/app/components/ProgressBar", () => (props: { duration: number }) => {
  const { View } = require("react-native");
  return <View testID="progress-bar" duration={props.duration} />;
});

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const textOf = (root: ReactTestInstance, id: string) => root.find((n) => n.props.testID === id && typeof n.type === "string").props.children;

// ── Pure helpers ─────────────────────────────────────────

describe("waiting-photo helpers", () => {
  it("applyWaitingPhoto leaves the previous round and paints the server's wait", () => {
    const s = {
      setPhoto: jest.fn(), setIsOwner: jest.fn(), setRound: jest.fn(), setPhase: jest.fn(), setPhaseDuration: jest.fn(),
      setPhaseKey: jest.fn(), setCorrectAnswer: jest.fn(), setScores: jest.fn(), setMySelection: jest.fn(),
      setGameHeld: jest.fn(), setPressing: jest.fn(),
    };
    applyWaitingPhoto({ round: 4, duration: 15_000 }, s);
    expect(s.setPhoto).toHaveBeenCalledWith(null);
    expect(s.setPhase).toHaveBeenCalledWith("waiting-photo");
    expect(s.setRound).toHaveBeenCalledWith(4);
    expect(s.setPhaseDuration).toHaveBeenCalledWith(15_000);
    expect(s.setScores).toHaveBeenCalledWith(null);
    expect(s.setMySelection).toHaveBeenCalledWith("");
  });

  it("the owner who reported photo-unavailable gets their own reason; everyone else the room's", () => {
    expect(skipNoticeFor({ round: 2, reason: "timeout" }, null)).toBe("timeout");
    expect(skipNoticeFor({ round: 2, reason: "unavailable" }, null)).toBe("unavailable");
    expect(skipNoticeFor({ round: 2, reason: "unavailable" }, "permission")).toBe("own-permission");
    expect(skipNoticeFor({ round: 2, reason: "timeout" }, "upload")).toBe("timeout");
  });

  it("every notice is translated in en and es", () => {
    const notices = ["timeout", "unavailable", "own-permission", "own-no-photos", "own-failed", "own-upload"] as const;
    for (const t of [en, es]) {
      for (const n of notices) expect(skipNoticeText(t, n)).toEqual(expect.any(String));
      expect(t.someoneChoosingPhoto).toBeTruthy();
      expect(t.uploadingYourPhoto).toBeTruthy();
    }
    expect(skipNoticeText(es, "timeout")).not.toBe(skipNoticeText(en, "timeout"));
  });
});

// ── GameScreen ───────────────────────────────────────────

describe("GameScreen while a photo is awaited", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(async () => {
    jest.useFakeTimers();
    mockReplace.mockClear();
    mockPickGamePhoto.mockReset();
    mockUploadPhoto.mockReset();
    await act(async () => { r = TestRenderer.create(<GameScreen />); });
    mockSocket.emitted = [];
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("everyone sees 'someone is choosing a photo' with the server's progress bar instead of the old scores", () => {
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000, isOwner: false }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);
    expect(r.root.find((n) => n.props.testID === "progress-bar").props.duration).toBe(15_000);
    expect(has(r.root, TEST_IDS.roundSkippedNotice)).toBe(false);

    // The photo arrives: the round is shown
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 2, duration: 8_000, isOwner: false }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(false);
  });

  it("a skipped round shows a translated notice on the waiting screen until the next round starts", () => {
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.roundSkippedTimeout);
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.roundSkippedUnavailable);
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 1, duration: 8_000, isOwner: false }));
    expect(has(r.root, TEST_IDS.roundSkippedNotice)).toBe(false);
  });

  // EXP-069: the room's photo is only requested with the room credentials
  it("shows the round's photo only with the room credentials as image headers", async () => {
    await flush();
    mockPhotoProps.length = 0;
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 1, duration: 8_000, isOwner: false }));
    expect(mockPhotoProps.length).toBeGreaterThan(0);
    for (const p of mockPhotoProps) expect(p.headers).toEqual({ Authorization: "Bearer tok-123", "X-Game-Code": "123456" });
  });

  it("my turn shows 'uploading your photo' and sends the uploaded photo", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockResolvedValue("/temp/" + "a".repeat(32) + ".jpg");
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.uploadingYourPhoto);
    await flush();
    expect(mockSocket.emitted).toContainEqual(["photo-sent", { photo: "/temp/" + "a".repeat(32) + ".jpg" }]);
    expect(mockSocket.emitted.some(([ev]) => ev === "photo-unavailable")).toBe(false);
    // EXP-069: uploaded as this room member (room code + rejoin token)
    expect(mockUploadPhoto).toHaveBeenCalledWith(expect.any(String), "file:///p1.jpg", { gameCode: "123456", token: "tok-123" });
  });

  it("no gallery access on my turn: reports photo-unavailable, stays in the game and explains why (EXP-040/041)", async () => {
    mockPickGamePhoto.mockResolvedValue({ error: "permission" });
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
    expect(mockSocket.emitted.filter(([ev]) => ev === "photo-unavailable")).toHaveLength(1);
    expect(mockUploadPhoto).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);

    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.ownPhotoNoPermission);
  });

  it("no photos on my turn: photo-unavailable with my own notice", async () => {
    mockPickGamePhoto.mockResolvedValue({ error: "no-photos" });
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.ownPhotoNoPhotos);
  });

  it("every upload attempt fails: photo-unavailable after the 3 retries, not a silent 15 s wait", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockRejectedValue(new Error("Upload failed: 500"));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await flush();
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await flush();
    expect(mockUploadPhoto).toHaveBeenCalledTimes(3);
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.ownPhotoUploadFailed);
  });

  it("a turn that ended (timeout) before the gallery answered reports nothing and shows the room's notice", async () => {
    let rejectPick!: (e: Error) => void;
    mockPickGamePhoto.mockReturnValue(new Promise((_, rej) => { rejectPick = rej; })); // permission dialog left open
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    await act(async () => { rejectPick(new Error("gallery closed")); });
    await flush();
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" })); // someone else's report
    expect(mockSocket.emitted.some(([ev]) => ev === "photo-unavailable")).toBe(false);
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.roundSkippedUnavailable);
  });

  it("re-picked for the same round: the old flow neither reports nor sends, and doesn't break the new turn", async () => {
    let rejectOld!: (e: Error) => void;
    mockPickGamePhoto.mockReturnValueOnce(new Promise((_, rej) => { rejectOld = rej; }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));

    // New request for the same round: uploads its own photo
    let resolveNew!: (v: { uri: string }) => void;
    mockPickGamePhoto.mockReturnValueOnce(new Promise((res) => { resolveNew = res; }));
    mockUploadPhoto.mockResolvedValue("/temp/" + "b".repeat(32) + ".jpg");
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 2 }));
    await act(async () => { rejectOld(new Error("gallery closed")); });
    await flush();
    expect(mockSocket.emitted.some(([ev]) => ev === "photo-unavailable")).toBe(false);
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.uploadingYourPhoto);

    await act(async () => { resolveNew({ uri: "file:///p2.jpg" }); });
    await flush();
    expect(mockSocket.emitted).toEqual([["photo-sent", { photo: "/temp/" + "b".repeat(32) + ".jpg" }]]);
  });

  it("an upload that finishes after its turn ended is not sent", async () => {
    let resolveUpload!: (url: string) => void;
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockReturnValue(new Promise((res) => { resolveUpload = res; }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    await act(async () => { resolveUpload("/temp/" + "c".repeat(32) + ".jpg"); });
    await flush();
    expect(mockSocket.emitted).toEqual([]);
  });

  it("an upload that finishes while paused is re-sent when the server asks again on resume", async () => {
    let resolveUpload!: (url: string) => void;
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockReturnValue(new Promise((res) => { resolveUpload = res; }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    await act(async () => { resolveUpload("/temp/" + "d".repeat(32) + ".jpg"); });
    await flush();
    expect(mockSocket.emitted).toEqual([]);
    act(() => mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 5_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    expect(mockSocket.emitted).toEqual([["photo-sent", { photo: "/temp/" + "d".repeat(32) + ".jpg" }]]);
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  });

  it("a rejoin snapshot in waiting-photo shows the waiting screen with the remaining wait", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "waiting-photo", round: 2, totalRounds: 10, isOwner: false, photo: null, correctAnswer: null,
      duration: 6_000, held: false, pause: null, scores: [], players: [],
    }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(r.root.find((n) => n.props.testID === "progress-bar").props.duration).toBe(6_000);
  });

  it("resuming a pause taken between rounds goes to the waiting screen", () => {
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000, isOwner: false }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    act(() => mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 1_500 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
  });
});
