import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";

// EXP-035 / EXP-126: the photo picked to plant belongs to one game. plantPhoto uploads it and sends plant-photo at
// once (from the lobby, so im-ready never waits for it); it is dropped by "Play again" (which keeps the socket,
// EXP-172) and whenever the game socket ends (exit, leaving, kicked), so the next game never re-plants it.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockSocket = new FakeSocket();
const mockIo = jest.fn(() => mockSocket);
jest.mock("socket.io-client", () => ({ io: () => mockIo() }));
const UPLOADED = "/temp/" + "c".repeat(32) + ".jpg";
const mockUpload = jest.fn(async (..._args: unknown[]) => UPLOADED);
jest.mock("../app/utils/uploadPhoto", () => ({ uploadPhoto: (...args: unknown[]) => mockUpload(...args) }));

import { GameProvider, useGameContext } from "../app/providers/GameContext";
import { PLANT_UPLOAD_RETRY, UploadHttpError } from "../app/utils/uploadRetry";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => {
  mockUpload.mockReset(); // also drops a held upload a failed test left queued
  mockUpload.mockImplementation(async () => UPLOADED);
  mockSocket.reset();
});

const plantPhotoUrls = () => mockSocket.emittedPayloads("plant-photo");
// The server's answer to the screens' join-create-game: binds the socket's current connection to the room
const joinAnswered = (hasPlantedPhoto = false) => act(() => mockSocket.fire("room-of-game", {
  success: true, room: { gameCode: "ABC123", players: [], rounds: 5, started: false, phase: null, round: 0 }, hasPlantedPhoto,
}));

// socket.io reconnected: a new server socket, in no room until its rejoin is answered
const reconnect = () => act(() => { mockSocket.connected = true; mockSocket.fire("connect"); });
// The next upload answers only when the test releases it
const holdNextUpload = () => {
  const held = { release: (_url: string) => {} };
  mockUpload.mockImplementationOnce(() => new Promise<string>((res) => { held.release = res; }));
  return held;
};

const mount = () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  act(() => ctx.startSocket());
  act(() => ctx.saveRejoinToken("ABC123", "bob", "tok"));
  joinAnswered();
  return r;
};

describe("GameContext planted photo", () => {
  it("plantPhoto uploads the picked photo and sends plant-photo right away", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    let ok = false;
    await act(async () => { ok = await ctx.plantPhoto(); });
    expect(ok).toBe(true);
    expect(mockUpload).toHaveBeenCalledWith(expect.any(String), "file:///picked.jpg", { gameCode: "ABC123", token: "tok" }, expect.any(Function));
    expect(plantPhotoUrls()).toEqual([{ photoUrl: UPLOADED }]);
    expect(ctx.plantedPhotoSent).toBe(true);
    expect(ctx.plantedPhotoUri).toBe("file:///picked.jpg"); // still shown as planted in the lobby
    act(() => r.unmount());
  });

  it("Play again (EXP-172): the lobby reuses the connected socket and the planted photo is dropped without it", () => {
    const r = mount();
    const first = ctx.socket;
    const ioCalls = mockIo.mock.calls.length;
    mockSocket.disconnect.mockClear();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    act(() => ctx.setPlantedPhotoUri(null)); // FinalScoreModal's Play again
    act(() => ctx.startSocket()); // WaitingRoom mount
    expect(ctx.plantedPhotoUri).toBeNull();
    expect(ctx.socket).toBe(first);
    expect(mockIo.mock.calls.length).toBe(ioCalls);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("is cleared when the game socket ends (exit, leave, kicked)", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    await act(async () => { await ctx.plantPhoto(); });
    act(() => ctx.endSocket());
    expect(ctx.plantedPhotoUri).toBeNull();
    expect(ctx.plantedPhotoSent).toBe(false);
    // Nothing left to plant in the next game
    let ok = true;
    await act(async () => { ok = await ctx.plantPhoto(); });
    expect(ok).toBe(false);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  // EXP-274: socket.io would buffer plant-photo and flush it on the new socket before the rejoin, where the server
  // drops it: the photo must stay not sent, so the rejoin (lobby room-of-game, or the game's im-ready) plants it again
  it("offline once uploaded: plant-photo is not sent nor marked sent, and the retry once back sends it", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    let release!: (url: string) => void;
    mockUpload.mockImplementationOnce(() => new Promise<string>((res) => { release = res; }));
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    mockSocket.connected = false; // the connection drops while it uploads
    await act(async () => { release(UPLOADED); expect(await first).toBe(false); });
    expect(plantPhotoUrls()).toEqual([]);
    expect(ctx.plantedPhotoSent).toBe(false);
    expect(ctx.plantUpload).toBe("idle"); // not a failed upload: nothing to report, the rejoin retries it
    expect(ctx.plantedPhotoUri).toBe("file:///picked.jpg");

    reconnect();
    joinAnswered(); // rejoined
    let ok = false;
    await act(async () => { ok = await ctx.plantPhoto(); });
    expect(ok).toBe(true);
    expect(plantPhotoUrls()).toEqual([{ photoUrl: UPLOADED }]);
    expect(ctx.plantedPhotoSent).toBe(true);
    act(() => r.unmount());
  });

  // EXP-280: back online, the new server socket is in no room until the rejoin's room-of-game: a plant-photo sent
  // before that (e.g. while the screen reads the rejoin token) is dropped, so it must not count as sent
  it("uploaded once reconnected but before the rejoin is answered: not sent until the rejoin plants it", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    const upload = holdNextUpload();
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    mockSocket.connected = false; // the connection drops while it uploads...
    reconnect(); // ...and comes back on a new server socket, its rejoin not answered yet
    await act(async () => { upload.release(UPLOADED); expect(await first).toBe(false); });
    expect(plantPhotoUrls()).toEqual([]);
    expect(ctx.plantedPhotoSent).toBe(false);
    expect(ctx.plantUpload).toBe("idle");

    joinAnswered(); // the screen's room-of-game handler then plants it again
    await act(async () => { expect(await ctx.plantPhoto()).toBe(true); });
    expect(plantPhotoUrls()).toEqual([{ photoUrl: UPLOADED }]);
    expect(ctx.plantedPhotoSent).toBe(true);
    act(() => r.unmount());
  });

  it("a refused rejoin leaves the socket out of the room", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    reconnect();
    act(() => mockSocket.fire("room-of-game", { success: false, message: "Game already started" }));
    await act(async () => { expect(await ctx.plantPhoto()).toBe(false); });
    expect(plantPhotoUrls()).toEqual([]);
    act(() => r.unmount());
  });

  // EXP-278: the socket reconnects while the planted photo uploads, and the rejoin's room-of-game (without my planted
  // photo) asks to plant it (e.g. the app was suspended for longer than the server keeps an unclaimed planted upload):
  // that upload's answer may be a photo the server already deleted, so it is uploaded again and only the new one sent
  it("reconnected while the photo uploads: uploads it again once done and sends only the new upload", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    const stale = holdNextUpload();
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    mockSocket.connected = false;
    reconnect();
    joinAnswered(false);
    let second!: Promise<boolean>;
    act(() => { second = ctx.plantPhoto(); }); // the lobby's room-of-game handler
    expect(mockUpload).toHaveBeenCalledTimes(1); // one upload at a time
    expect(ctx.plantUpload).toBe("uploading");

    const FRESH = "/temp/" + "f".repeat(32) + ".jpg";
    mockUpload.mockImplementationOnce(async () => FRESH);
    await act(async () => { stale.release(UPLOADED); });
    expect(await first).toBe(true);
    expect(await second).toBe(true); // both callers get the outcome
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(plantPhotoUrls()).toEqual([{ photoUrl: FRESH }]);
    expect(ctx.plantedPhotoSent).toBe(true);
    expect(ctx.plantUpload).toBe("idle");
    act(() => r.unmount());
  });

  // The normal path, no reconnection: the host starts before the lobby upload ends and the game screen asks again
  // after im-ready. It waits for the upload in flight instead of uploading the photo a second time.
  it("asked again while the same photo uploads, with no reconnection: one upload, sent once", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    const upload = holdNextUpload();
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    let second!: Promise<boolean>;
    act(() => { second = ctx.plantPhoto(); }); // GameScreen after im-ready
    await act(async () => { upload.release(UPLOADED); });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(plantPhotoUrls()).toEqual([{ photoUrl: UPLOADED }]);
    act(() => r.unmount());
  });

  it("a photo replaced after a reconnection during its upload is not uploaded again", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    const upload = holdNextUpload();
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    mockSocket.connected = false;
    reconnect(); // would upload A again...
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg")); // ...but it was replaced
    await act(async () => { upload.release(UPLOADED); expect(await first).toBe(false); });
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(plantPhotoUrls()).toEqual([]);
    act(() => r.unmount());
  });

  it("a photo replaced while uploading is not sent", async () => {
    const r = mount();
    let release!: (url: string) => void;
    mockUpload.mockImplementationOnce(() => new Promise<string>((res) => { release = res; }));
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    let first!: Promise<boolean>;
    act(() => { first = ctx.plantPhoto(); });
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg")); // changed photo while A uploads
    await act(async () => { release("/temp/" + "a".repeat(32) + ".jpg"); expect(await first).toBe(false); });
    expect(plantPhotoUrls()).toEqual([]);
    act(() => r.unmount());
  });
});

// EXP-269: a busy server refuses uploads with 429/503 + Retry-After (e.g. a party on one wifi planting at once). The
// planted photo is retried like the turn photo, only console.log'ged, and only counts as sent once the server has it.
describe("GameContext planted photo on a busy server", () => {
  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  const busy = () => new UploadHttpError(429, 2000);

  let random: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    random = jest.spyOn(Math, "random").mockReturnValue(0); // no retry jitter: exact waits
    jest.spyOn(console, "error").mockImplementation(() => {});
    (console.error as jest.Mock).mockClear();
  });
  afterEach(() => {
    random.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
    mockUpload.mockReset();
    mockUpload.mockImplementation(async () => UPLOADED);
  });

  it("retries after the server's Retry-After and sends plant-photo once it is in", async () => {
    const r = mount();
    mockUpload.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
    act(() => ctx.setPlantedPhotoUri("file:///picked.jpg"));
    let ok: boolean | null = null;
    act(() => { ctx.plantPhoto().then((v) => { ok = v; }); });
    await advance(0);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(ctx.plantedPhotoSent).toBe(false); // not "planted" while the server hasn't got it
    await advance(2000);
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(ctx.plantedPhotoSent).toBe(false);
    await advance(2000);
    expect(ok).toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(3);
    expect(plantPhotoUrls()).toEqual([{ photoUrl: UPLOADED }]);
    expect(ctx.plantedPhotoSent).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("gives up after PLANT_UPLOAD_RETRY: stays pending (not sent), with no error toast", async () => {
    const r = mount();
    mockUpload.mockRejectedValue(busy());
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    let ok: boolean | null = null;
    act(() => { ctx.plantPhoto().then((v) => { ok = v; }); });
    for (let i = 0; i < PLANT_UPLOAD_RETRY.attempts; i++) await advance(PLANT_UPLOAD_RETRY.maxWaitMs);
    expect(ok).toBe(false);
    expect(mockUpload).toHaveBeenCalledTimes(PLANT_UPLOAD_RETRY.attempts);
    expect(ctx.plantedPhotoUri).toBe("file:///a.jpg"); // kept: the game screen retries it after im-ready
    expect(ctx.plantedPhotoSent).toBe(false);
    expect(plantPhotoUrls()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("stops retrying a photo replaced while it waits to retry, right after that wait", async () => {
    const r = mount();
    mockUpload.mockRejectedValueOnce(busy());
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    let ok: boolean | null = null;
    act(() => { ctx.plantPhoto().then((v) => { ok = v; }); });
    await advance(0);
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg"));
    await advance(1999);
    expect(ok).toBeNull(); // still in the wait in progress (Retry-After 2 s)...
    await advance(1);
    expect(ok).toBe(false); // ...and done right after it, without the remaining waits (2 s, 3 s, 4 s, 5 s)
    expect(mockUpload).toHaveBeenCalledTimes(1); // A is never uploaded again
    expect(plantPhotoUrls()).toEqual([]);
    expect(ctx.plantUpload).toBe("idle"); // a replaced photo is not reported as failed
    // A's upload slot is free again at once
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    await act(async () => { expect(await ctx.plantPhoto()).toBe(true); });
    act(() => r.unmount());
  });

  it("tells the upload a photo replaced during its conversion is no longer wanted", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    await act(async () => { await ctx.plantPhoto(); });
    const stillWanted = mockUpload.mock.calls[0][3] as () => boolean;
    expect(stillWanted()).toBe(true);
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg"));
    expect(stillWanted()).toBe(false);
    act(() => r.unmount());
  });

  it("plantUpload: uploading while it runs, idle once in, failed once it gives up", async () => {
    const r = mount();
    expect(ctx.plantUpload).toBe("idle");
    mockUpload.mockRejectedValueOnce(busy());
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    act(() => { ctx.plantPhoto(); });
    await advance(0);
    expect(ctx.plantUpload).toBe("uploading");
    await advance(2000);
    expect(ctx.plantUpload).toBe("idle");
    expect(ctx.plantedPhotoSent).toBe(true);

    mockUpload.mockRejectedValue(new UploadHttpError(403, null)); // final
    act(() => ctx.setPlantedPhotoUri("file:///b.jpg"));
    await act(async () => { expect(await ctx.plantPhoto()).toBe(false); });
    expect(ctx.plantUpload).toBe("failed");
    act(() => ctx.setPlantedPhotoUri("file:///c.jpg")); // picking another photo clears it
    expect(ctx.plantUpload).toBe("idle");
    act(() => r.unmount());
  });

  it("re-planting (the server lost it) shows not sent until the server has it again", async () => {
    const r = mount();
    act(() => ctx.setPlantedPhotoUri("file:///a.jpg"));
    await act(async () => { await ctx.plantPhoto(); });
    expect(ctx.plantedPhotoSent).toBe(true);
    mockUpload.mockRejectedValueOnce(busy());
    act(() => { ctx.plantPhoto(); });
    await advance(0);
    expect(ctx.plantedPhotoSent).toBe(false);
    await advance(2000);
    expect(ctx.plantedPhotoSent).toBe(true);
    act(() => r.unmount());
  });
});
