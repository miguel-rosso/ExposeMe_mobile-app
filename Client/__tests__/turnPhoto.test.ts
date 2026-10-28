import { MAX_TURN_PHOTO_PICKS, PhotoWait, TurnPhotoDeps, photoWaitOf, pickAndUploadTurnPhoto } from "../app/utils/turnPhoto";
import { initialRoundView } from "../app/utils/roundState";
import { PhotoConversionError, UploadHttpError } from "../app/utils/uploadRetry";

// EXP-292: a photo that can't be converted (corrupt, unsupported format) no longer skips my turn: another photo is
// picked, a bounded number of times, while the turn still wants one and the server's photo wait isn't over.

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

const unconvertible = () => new PhotoConversionError(new Error("unsupported format"));
const picks = (...uris: string[]) => {
  const pick = jest.fn();
  uris.forEach((uri) => pick.mockResolvedValueOnce({ uri }));
  return pick;
};
/** Clock moved by hand: an upload advances it to model a slow conversion. */
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};
const deps = (over: Partial<TurnPhotoDeps> & { pick?: jest.Mock; upload?: jest.Mock }) => ({
  pick: picks("file:///a.jpg"),
  upload: jest.fn().mockResolvedValue("/temp/a.jpg"),
  stillWanted: () => true,
  photoWait: (): PhotoWait | null => ({ key: 1, durationMs: 15_000 }),
  paused: () => false,
  ...over,
});

describe("pickAndUploadTurnPhoto", () => {
  it("uploads the picked photo", async () => {
    const d = deps({});
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ url: "/temp/a.jpg" });
    expect(d.pick).toHaveBeenCalledTimes(1);
  });

  it("picks another photo when the first can't be converted, and sends that one", async () => {
    const upload = jest.fn().mockRejectedValueOnce(unconvertible()).mockResolvedValue("/temp/b.jpg");
    const d = deps({ pick: picks("file:///bad.heic", "file:///b.jpg"), upload });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ url: "/temp/b.jpg" });
    expect(upload.mock.calls.map(([uri]) => uri)).toEqual(["file:///bad.heic", "file:///b.jpg"]);
  });

  it(`gives up as "upload" after ${MAX_TURN_PHOTO_PICKS} unconvertible photos`, async () => {
    const upload = jest.fn().mockRejectedValue(unconvertible());
    const d = deps({ pick: picks("file:///1", "file:///2", "file:///3", "file:///4"), upload });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "upload" });
    expect(d.pick).toHaveBeenCalledTimes(MAX_TURN_PHOTO_PICKS);
  });

  it("does not pick again for a failure that is not the photo's (refused upload)", async () => {
    const upload = jest.fn().mockRejectedValue(new UploadHttpError(403, null));
    const d = deps({ pick: picks("file:///a", "file:///b"), upload });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "upload" });
    expect(d.pick).toHaveBeenCalledTimes(1);
  });

  it("does not pick again once the turn no longer wants a photo", async () => {
    let wanted = true;
    const upload = jest.fn().mockImplementation(async () => { wanted = false; throw unconvertible(); });
    const d = deps({ pick: picks("file:///a", "file:///b"), upload, stillWanted: () => wanted });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "upload" });
    expect(d.pick).toHaveBeenCalledTimes(1);
  });

  it("does not pick again once the server's photo wait is over", async () => {
    const c = clock();
    const upload = jest.fn().mockImplementation(async () => { c.advance(15_000); throw unconvertible(); });
    const d = deps({ pick: picks("file:///a", "file:///b"), upload, now: c.now });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "upload" });
    expect(d.pick).toHaveBeenCalledTimes(1);
  });

  it("does not upload a photo picked after the server's photo wait is over", async () => {
    const c = clock();
    const pick = jest.fn().mockImplementation(async () => { c.advance(15_000); return { uri: "file:///a" }; });
    const d = deps({ pick, now: c.now });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "upload" });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("with an unknown wait, picks again bounded by the pick count only", async () => {
    const upload = jest.fn().mockRejectedValueOnce(unconvertible()).mockResolvedValue("/temp/b.jpg");
    const d = deps({ pick: picks("file:///a", "file:///b"), upload, photoWait: () => null });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ url: "/temp/b.jpg" });
  });

  it("reports why when a later pick finds no photo", async () => {
    const pick = jest.fn().mockResolvedValueOnce({ uri: "file:///a" }).mockResolvedValueOnce({ error: "no-photos" });
    const d = deps({ pick, upload: jest.fn().mockRejectedValue(unconvertible()) });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ error: "no-photos" });
  });

  // A pause freezes the server's wait: time spent paused never runs it out, and the resume restarts it from what the
  // server says is left
  it("a pause longer than the wait left during a conversion: after the resume, a failed photo is still replaced", async () => {
    const c = clock();
    let wait: PhotoWait = { key: 1, durationMs: 15_000 };
    let paused = false;
    const upload = jest.fn()
      .mockImplementationOnce(async () => {
        c.advance(5_000);
        paused = true; // game-paused: 10 s of the wait left, frozen
        c.advance(30_000);
        paused = false; // game-resumed: the server gives the 10 s left
        wait = { key: 2, durationMs: 10_000 };
        throw unconvertible();
      })
      .mockResolvedValue("/temp/b.jpg");
    const d = deps({
      pick: picks("file:///bad", "file:///b"), upload, now: c.now, photoWait: () => wait, paused: () => paused,
    });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ url: "/temp/b.jpg" });
    expect(d.pick).toHaveBeenCalledTimes(2);
  });

  it("while still paused past the wait left, a failed photo is still replaced", async () => {
    const c = clock();
    let paused = false;
    const upload = jest.fn()
      .mockImplementationOnce(async () => { paused = true; c.advance(30_000); throw unconvertible(); })
      .mockResolvedValue("/temp/b.jpg");
    const d = deps({ pick: picks("file:///bad", "file:///b"), upload, now: c.now, paused: () => paused });
    await expect(pickAndUploadTurnPhoto(d)).resolves.toEqual({ url: "/temp/b.jpg" });
  });
});

describe("photoWaitOf", () => {
  it("is the server's photo wait in waiting-photo, unknown in any other phase", () => {
    const waiting = { ...initialRoundView, phase: "waiting-photo" as const, phaseKey: 4, phaseDuration: 9_000 };
    expect(photoWaitOf(waiting)).toEqual({ key: 4, durationMs: 9_000 });
    expect(photoWaitOf({ ...waiting, phase: "answering" })).toBeNull();
  });
});
