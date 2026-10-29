import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { skipNoticeFor, skipNoticeText } from "../app/utils/waitingPhoto";
import { TEST_IDS } from "../app/utils/testIds";
import { PhotoConversionError, TURN_UPLOAD_RETRY } from "../app/utils/uploadRetry";
import { MAX_TURN_PHOTO_PICKS } from "../app/utils/turnPhoto";
import en from "../app/i18n/en";
import es from "../app/i18n/es";
// Loaded with the file (jest.mock calls below are hoisted above it): a cold transform must not hit the test timeout
import GameScreen from "../app/screens/GameScreen";

// EXP-039 / EXP-040 / EXP-041: the waiting screen while the server awaits the chosen player's photo, the owner's
// photo-unavailable report (no access / no photos / upload failed) and never leaving the game for a permission.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockReplace = jest.fn();
const mockSocket = new FakeSocket();
const mockPickGamePhoto = jest.fn();
const mockUploadPhoto = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace }), useLocalSearchParams: () => ({}), useFocusEffect: () => {},
}));
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
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => mockSocket.fire("waiting-photo", { round: 2, duration: 15_000 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);
    expect(r.root.find((n) => n.props.testID === "progress-bar").props.duration).toBe(15_000);
    expect(has(r.root, TEST_IDS.roundSkippedNotice)).toBe(false);

    // The photo arrives: the round is shown
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 2, duration: 8_000 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(false);
  });

  it("a skipped round shows a translated notice on the waiting screen until the next round starts", () => {
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.roundSkippedTimeout);
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
    expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.roundSkippedUnavailable);
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 1, duration: 8_000 }));
    expect(has(r.root, TEST_IDS.roundSkippedNotice)).toBe(false);
  });

  // EXP-069: the room's photo is only requested with the room credentials
  it("shows the round's photo only with the room credentials as image headers", async () => {
    await flush();
    mockPhotoProps.length = 0;
    act(() => mockSocket.fire("round-start", { photo: "/temp/y.jpg", round: 1, duration: 8_000 }));
    expect(mockPhotoProps.length).toBeGreaterThan(0);
    for (const p of mockPhotoProps) expect(p.headers).toEqual({ Authorization: "Bearer tok-123", "X-Game-Code": "123456" });
  });

  // EXP-252: my turn must stay invisible (I may then guess my own photo): same text as everyone's, upload in the background
  it("my turn shows the same 'someone is choosing a photo' as everyone and sends the uploaded photo", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockResolvedValue("/temp/" + "a".repeat(32) + ".jpg");
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    const everyonesScreen = JSON.stringify(r.toJSON());
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);
    expect(JSON.stringify(r.toJSON())).toBe(everyonesScreen); // nothing on screen changes
    await flush();
    expect(JSON.stringify(r.toJSON())).toBe(everyonesScreen);
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

  describe("upload retries (EXP-269)", () => {
    let random: jest.SpyInstance;
    beforeEach(() => { random = jest.spyOn(Math, "random").mockReturnValue(0); }); // no jitter: exact 1 s, 2 s, 3 s
    afterEach(() => random.mockRestore());
    const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };
    const reported = () => mockSocket.emitted.some(([ev]) => ev === "photo-unavailable");

    it("every upload attempt fails: photo-unavailable after exactly 4 attempts, not a silent 15 s wait", async () => {
      mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
      mockUploadPhoto.mockRejectedValue(new TypeError("Network request failed"));
      act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
      act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
      await flush();
      expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
      await advance(1_000);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
      await advance(2_000);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(3);
      await advance(2_999);
      expect(reported()).toBe(false); // still within the third wait
      await advance(1);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(4);
      expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
      // A fifth attempt (4 s more) would pass TURN_UPLOAD_RETRY.maxTotalWaitMs
      await advance(TURN_UPLOAD_RETRY.maxTotalWaitMs);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(4);
      act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" }));
      expect(textOf(r.root, TEST_IDS.roundSkippedNotice)).toBe(en.ownPhotoUploadFailed);
    });

    it("my turn ending while a retry waits stops the uploads (the photo would come too late)", async () => {
      mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
      mockUploadPhoto.mockRejectedValue(new TypeError("Network request failed"));
      act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
      act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
      await flush();
      expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
      act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
      await advance(TURN_UPLOAD_RETRY.maxTotalWaitMs);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
      expect(reported()).toBe(false);
    });

    // EXP-076: retrying can't fix a photo that doesn't convert: each one gets a single attempt, with no wait.
    // EXP-292: another photo is picked instead; the room is told once MAX_TURN_PHOTO_PICKS of them failed that way
    it("photos that can't be converted get a single attempt each, then the turn is reported unavailable", async () => {
      mockPickGamePhoto.mockResolvedValue({ uri: "file:///broken.heic" });
      mockUploadPhoto.mockRejectedValue(new PhotoConversionError(new Error("Could not decode image")));
      act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
      act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
      await flush();
      expect(mockPickGamePhoto).toHaveBeenCalledTimes(MAX_TURN_PHOTO_PICKS);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(MAX_TURN_PHOTO_PICKS);
      expect(mockSocket.emitted).toEqual([["photo-unavailable", { round: 1, attempt: 1 }]]);
      await advance(TURN_UPLOAD_RETRY.maxTotalWaitMs);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(MAX_TURN_PHOTO_PICKS);
    });

    // EXP-076: the retries fit the photo wait the server gave: a rejoin with 5 s left gets 2.5 s of waits, not 7.5 s
    it("with 5 s left of the photo wait, the retries stop within half of it", async () => {
      mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
      mockUploadPhoto.mockRejectedValue(new TypeError("Network request failed"));
      act(() => mockSocket.fire("game-state", {
        started: true, phase: "waiting-photo", round: 0, totalRounds: 10, photo: null, correctAnswer: null,
        duration: 5_000, phaseTotal: 15_000, held: false, pause: null, scores: [], players: [],
      }));
      act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
      await flush();
      await advance(1_000);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
      expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
      await advance(TURN_UPLOAD_RETRY.maxTotalWaitMs);
      expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
    });
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

  // EXP-237: my report was answered by a round-skipped lost while offline; the rejoin snapshot ends that turn
  it("after a rejoin snapshot, another player's skipped round shows the room's notice, not my old reason", async () => {
    mockPickGamePhoto.mockResolvedValue({ error: "permission" });
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    expect(mockSocket.emitted).toContainEqual(["photo-unavailable", { round: 1, attempt: 1 }]);
    // Offline meanwhile: round-skipped (and the next waiting-photo) never arrived; the rejoin answers with a snapshot
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "waiting-photo", round: 1, totalRounds: 10, photo: null, correctAnswer: null,
      duration: 9_000, held: false, pause: null, scores: [], players: [],
    }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "unavailable" })); // someone else's report
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
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);

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

  // EXP-232: every event that ends my photo request drops the result of an upload still in flight
  describe.each([
    ["waiting-photo", { round: 2, duration: 15_000 }],
    ["round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }],
    ["round-skipped", { round: 1, reason: "timeout" }],
    ["game-state", {
      started: true, phase: "waiting-photo", round: 1, totalRounds: 10, photo: null, correctAnswer: null,
      duration: 6_000, held: false, pause: null, scores: [], players: [],
    }],
  ])("my turn ended by %s", (event, payload) => {
    it("an upload finishing afterwards sends no photo-sent and the screen still says 'someone is choosing a photo'", async () => {
      let resolveUpload!: (url: string) => void;
      mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
      mockUploadPhoto.mockReturnValue(new Promise((res) => { resolveUpload = res; }));
      act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
      act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
      await flush();
      act(() => mockSocket.fire(event, payload));
      mockSocket.emitted = []; // only what the late upload does matters (game-state answers with im-ready)
      await act(async () => { resolveUpload("/temp/" + "e".repeat(32) + ".jpg"); });
      await flush();
      expect(mockSocket.emitted).toEqual([]);
      if (has(r.root, TEST_IDS.waitingPhotoText)) {
        expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);
      }
    });
  });

  it("a pause while my upload goes on shows the same text as everyone's", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockReturnValue(new Promise(() => {}));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    expect(textOf(r.root, TEST_IDS.waitingPhotoText)).toBe(en.someoneChoosingPhoto);
  });

  // EXP-269: a pause only suspends my request: the server accepts my upload meanwhile, so it (and its retries) go on,
  // nothing is sent while paused, and the resume's your-turn (same attempt) re-sends the uploaded photo
  it("an upload failing during a pause keeps retrying; the resume re-sends the uploaded photo without a new upload", async () => {
    const PHOTO = "/temp/" + "b".repeat(32) + ".jpg";
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValue(PHOTO);
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    for (let s = 0; s < 2; s++) {
      await act(async () => { jest.advanceTimersByTime(1_000); });
      await flush();
    }
    expect(mockUploadPhoto).toHaveBeenCalledTimes(2); // retried during the pause
    expect(mockSocket.emitted).toEqual([]); // nothing sent while paused

    act(() => mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 10_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 })); // resumed: same request
    await flush();
    expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
    expect(mockPickGamePhoto).toHaveBeenCalledTimes(1);
    expect(mockSocket.emitted).toEqual([["photo-sent", { photo: PHOTO }]]);
  });

  it("a pause while my photo is being picked still uploads it, and the resume sends it", async () => {
    const PHOTO = "/temp/" + "d".repeat(32) + ".jpg";
    let resolvePick!: (v: { uri: string }) => void;
    mockPickGamePhoto.mockReturnValue(new Promise((res) => { resolvePick = res; }));
    mockUploadPhoto.mockResolvedValue(PHOTO);
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    await act(async () => { resolvePick({ uri: "file:///p1.jpg" }); });
    await flush();
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(mockSocket.emitted).toEqual([]);
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 })); // resumed
    expect(mockSocket.emitted).toEqual([["photo-sent", { photo: PHOTO }]]);
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  });

  it("a round that moves on after a pause (round-skipped) cuts the suspended upload", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto.mockRejectedValue(new TypeError("Network request failed"));
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    act(() => mockSocket.fire("round-skipped", { round: 1, reason: "timeout" }));
    for (let s = 0; s < TURN_UPLOAD_RETRY.maxTotalWaitMs / 1_000; s++) {
      await act(async () => { jest.advanceTimersByTime(1_000); });
      await flush();
    }
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(mockSocket.emitted).toEqual([]);
  });

  it("a pause resumed while a retry waits keeps that retry going (same request)", async () => {
    mockPickGamePhoto.mockResolvedValue({ uri: "file:///p1.jpg" });
    mockUploadPhoto
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue("/temp/" + "c".repeat(32) + ".jpg");
    act(() => mockSocket.fire("waiting-photo", { round: 1, duration: 15_000 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 }));
    await flush();
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    act(() => mockSocket.fire("your-turn", { round: 1, attempt: 1 })); // resumed before the retry's wait is over
    for (let s = 0; s < 2; s++) {
      await act(async () => { jest.advanceTimersByTime(1_000); });
      await flush();
    }
    expect(mockUploadPhoto).toHaveBeenCalledTimes(2);
    expect(mockSocket.emitted).toContainEqual(["photo-sent", { photo: "/temp/" + "c".repeat(32) + ".jpg" }]);
  });

  it("a rejoin snapshot in waiting-photo shows the waiting screen with the remaining wait", () => {
    act(() => mockSocket.fire("game-state", {
      started: true, phase: "waiting-photo", round: 2, totalRounds: 10, photo: null, correctAnswer: null,
      duration: 6_000, held: false, pause: null, scores: [], players: [],
    }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(r.root.find((n) => n.props.testID === "progress-bar").props.duration).toBe(6_000);
  });

  it("resuming a pause taken between rounds goes to the waiting screen", () => {
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 1, duration: 8_000 }));
    act(() => mockSocket.fire("round-scores", { scores: [], round: 1, totalRounds: 10, duration: 5_000 }));
    act(() => mockSocket.fire("game-paused", { duration: 300_000, waitingFor: ["carol"], pause: 1, maxPauses: 3 }));
    act(() => mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 1_500 }));
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
  });

  // Back-to-back events in one render batch build on each other: the resume sees the scores phase just set
  it("round-scores and a waiting-photo resume in the same tick show the wait for the next round", () => {
    act(() => mockSocket.fire("round-start", { photo: "/temp/x.jpg", round: 3, duration: 8_000 }));
    act(() => {
      mockSocket.fire("round-scores", { scores: [], round: 3, totalRounds: 10, duration: 5_000 });
      mockSocket.fire("game-resumed", { phase: "waiting-photo", duration: 1_500 });
    });
    expect(has(r.root, TEST_IDS.gameWaitingPhoto)).toBe(true);
    expect(r.root.findByProps({ children: en.roundOf.replace("{round}", "4").replace("{total}", "10") })).toBeTruthy();
    expect(r.root.find((n) => n.props.testID === "progress-bar").props.duration).toBe(1_500);
  });
});
