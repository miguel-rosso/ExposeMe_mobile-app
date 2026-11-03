import {
  PLANT_UPLOAD_RETRY, PhotoConversionError, TURN_UPLOAD_RETRY, UploadAbandonedError, UploadHttpError, parseRetryAfterMs,
  turnUploadRetry, uploadWithRetry,
} from "../src/utils/uploadRetry";

// EXP-232: the turn photo's retried upload, extracted from GameScreen. EXP-269: only network errors and a busy
// server (408/429/503) are retried, after the server's Retry-After (floored at the backoff), with jitter, bounded per
// wait and in total; the planted photo is retried the same way, and either stops as soon as it is no longer wanted.

let random: jest.SpyInstance;
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  random = jest.spyOn(Math, "random").mockReturnValue(0); // no jitter unless a test sets it
});
afterEach(() => {
  random.mockRestore();
  jest.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const advance = async (ms: number) => { jest.advanceTimersByTime(ms); await flush(); };
const OPTIONS = { attempts: 3, backoffMs: 1000, maxWaitMs: 5000, maxTotalWaitMs: 10_000 };
const busy = (status: number, retryAfterMs: number | null) => new UploadHttpError(status, retryAfterMs);

describe("uploadWithRetry", () => {
  it("keeps the turn photo's retries inside the server's 15 s photo wait", () => {
    const PHOTO_WAIT_TIMEOUT_MS = 15_000; // Server/managers/GameEngine.ts
    expect(TURN_UPLOAD_RETRY.attempts).toBeGreaterThanOrEqual(4);
    expect(TURN_UPLOAD_RETRY.maxWaitMs).toBeLessThanOrEqual(5_000);
    // Leaves about half the wait to pick the photo and run the uploads themselves
    expect(TURN_UPLOAD_RETRY.maxTotalWaitMs).toBeLessThanOrEqual(PHOTO_WAIT_TIMEOUT_MS / 2 + 500);
    expect(PLANT_UPLOAD_RETRY.attempts).toBeGreaterThanOrEqual(TURN_UPLOAD_RETRY.attempts);
    expect(PLANT_UPLOAD_RETRY.maxWaitMs).toBeLessThanOrEqual(5_000);
  });

  it("returns the first successful upload without waiting", async () => {
    const upload = jest.fn().mockResolvedValue("/temp/a.jpg");
    await expect(uploadWithRetry("file:///p.jpg", upload)).resolves.toBe("/temp/a.jpg");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("file:///p.jpg");
  });

  it("retries a network error after backoffMs * n and succeeds on a later attempt", async () => {
    const upload = jest.fn().mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValue("/temp/b.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload);
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    await advance(999);
    expect(upload).toHaveBeenCalledTimes(1);
    await advance(1);
    await expect(result).resolves.toBe("/temp/b.jpg");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after every attempt failed, with no wait after the last one", async () => {
    const upload = jest.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, OPTIONS).catch((e) => e);
    await flush();
    await advance(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(upload).toHaveBeenCalledTimes(3);
    expect((await outcome).message).toBe("third");
    expect(jest.getTimerCount()).toBe(0);
  });

  // EXP-252: development builds show console.error/warn as a toast on the phone, which would tell the owner it's their
  // turn (and so whose photo comes next): failed attempts are only logged
  it("never logs an error or warning, even when every attempt fails", async () => {
    (console.error as jest.Mock).mockClear();
    (console.warn as jest.Mock).mockClear();
    const upload = jest.fn().mockRejectedValue(new Error("offline"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, attempts: 2, backoffMs: 10 }).catch((e) => e);
    await flush();
    await advance(10);
    expect((await outcome).message).toBe("offline");
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("honours custom options", async () => {
    const upload = jest.fn().mockRejectedValue(new Error("x"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, attempts: 2, backoffMs: 10 }).catch((e) => e);
    await flush();
    await advance(10);
    expect(upload).toHaveBeenCalledTimes(2);
    expect((await outcome).message).toBe("x");
  });

  // ── What is retried (EXP-269) ──

  it.each([400, 401, 403, 413, 500])("a %i is final: no retry", async (status) => {
    const upload = jest.fn().mockRejectedValue(busy(status, 2000));
    const outcome = await uploadWithRetry("file:///p.jpg", upload, OPTIONS).catch((e) => e);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status });
    expect(jest.getTimerCount()).toBe(0);
  });

  // EXP-076: the same photo fails to convert again: no retry
  it("a photo that can't be converted is final: no retry", async () => {
    const upload = jest.fn().mockRejectedValue(new PhotoConversionError(new Error("Could not decode image")));
    const outcome = await uploadWithRetry("file:///p.jpg", upload, OPTIONS).catch((e) => e);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(outcome).toBeInstanceOf(PhotoConversionError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 503])("a %i is retried", async (status) => {
    const upload = jest.fn().mockRejectedValueOnce(busy(status, null)).mockResolvedValue("/temp/r.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, OPTIONS);
    await flush();
    await advance(1000);
    await expect(result).resolves.toBe("/temp/r.jpg");
  });

  // ── Retry-After (EXP-269) ──

  it.each([429, 503])("waits the server's Retry-After on %i when it is longer than the backoff", async (status) => {
    const upload = jest.fn().mockRejectedValueOnce(busy(status, 2000)).mockResolvedValue("/temp/c.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, OPTIONS);
    await flush();
    await advance(1999);
    expect(upload).toHaveBeenCalledTimes(1); // the 1 s backoff alone would have retried already
    await advance(1);
    await expect(result).resolves.toBe("/temp/c.jpg");
  });

  it("floors the wait at the backoff when Retry-After is shorter", async () => {
    const upload = jest.fn()
      .mockRejectedValueOnce(busy(429, 1000))
      .mockRejectedValueOnce(busy(429, 0))
      .mockResolvedValue("/temp/g.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, OPTIONS);
    await flush();
    await advance(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    await advance(1999); // retry 2 waits backoff 2 s, not Retry-After 0
    expect(upload).toHaveBeenCalledTimes(2);
    await advance(1);
    await expect(result).resolves.toBe("/temp/g.jpg");
  });

  it.each([25 * 60_000, Infinity])(
    "gives up at once when the server asks to wait longer than maxWaitMs (%p ms, e.g. storage full)",
    async (retryAfterMs) => {
      const upload = jest.fn().mockRejectedValue(busy(503, retryAfterMs));
      const outcome = await uploadWithRetry("file:///p.jpg", upload, OPTIONS).catch((e) => e);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(outcome).toBeInstanceOf(UploadHttpError);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("caps the linear backoff at maxWaitMs", async () => {
    const upload = jest.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("/temp/e.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, backoffMs: 9000 });
    await flush();
    await advance(5000);
    await expect(result).resolves.toBe("/temp/e.jpg");
  });

  it("never waits more than maxTotalWaitMs in total, even with attempts left", async () => {
    const upload = jest.fn().mockRejectedValue(busy(429, 2000));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, attempts: 10, maxTotalWaitMs: 5000 })
      .catch((e) => e);
    for (let i = 0; i < 10; i++) await advance(1000);
    expect(await outcome).toBeInstanceOf(UploadHttpError);
    expect(upload).toHaveBeenCalledTimes(3); // waits 2 s + 2 s; the next (3 s backoff) would pass 5 s
  });

  it("the turn defaults outlast a busy server's short Retry-After (a party behind one IP)", async () => {
    const upload = jest.fn()
      .mockRejectedValueOnce(busy(429, 2000))
      .mockRejectedValueOnce(busy(429, 2000))
      .mockRejectedValueOnce(busy(429, 2000))
      .mockResolvedValue("/temp/f.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload);
    for (let i = 0; i < TURN_UPLOAD_RETRY.maxTotalWaitMs / 1000; i++) await advance(1000);
    await expect(result).resolves.toBe("/temp/f.jpg");
    expect(upload).toHaveBeenCalledTimes(4);
  });

  // ── Jitter (EXP-269): a party refused at once doesn't retry in lockstep ──

  it("adds up to min(1 s, half the wait) of jitter", async () => {
    random.mockReturnValue(0.999);
    const upload = jest.fn().mockRejectedValueOnce(busy(429, 2000)).mockResolvedValue("/temp/j.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, OPTIONS);
    await flush();
    await advance(2990);
    expect(upload).toHaveBeenCalledTimes(1); // 2 s + ~1 s jitter
    await advance(10);
    await expect(result).resolves.toBe("/temp/j.jpg");
  });

  it("jitter never takes a wait past maxWaitMs", async () => {
    random.mockReturnValue(0.999);
    const upload = jest.fn().mockRejectedValueOnce(busy(429, 2000)).mockResolvedValue("/temp/k.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, maxWaitMs: 2000 });
    await flush();
    await advance(2000);
    await expect(result).resolves.toBe("/temp/k.jpg");
  });

  it("jitter never takes the total past maxTotalWaitMs", async () => {
    random.mockReturnValue(0.999);
    const upload = jest.fn().mockRejectedValue(busy(429, 2000));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, maxTotalWaitMs: 5500 }).catch((e) => e);
    await flush();
    await advance(2999); // 2 s + 999 ms jitter
    expect(upload).toHaveBeenCalledTimes(2);
    await advance(2500); // 2 s base fits the 2.501 s left, its jitter only up to the budget
    expect(upload).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(await outcome).toBeInstanceOf(UploadHttpError);
  });

  // ── No longer wanted (EXP-269) ──

  it("stops before the first attempt when the upload is no longer wanted", async () => {
    const upload = jest.fn().mockResolvedValue("/temp/h.jpg");
    const outcome = await uploadWithRetry("file:///p.jpg", upload, OPTIONS, () => false).catch((e) => e);
    expect(outcome).toBeInstanceOf(UploadAbandonedError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("stops right after the current wait, without the remaining ones, once no longer wanted", async () => {
    let wanted = true;
    const upload = jest.fn().mockRejectedValue(new Error("offline"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { ...OPTIONS, attempts: 5 }, () => wanted).catch((e) => e);
    await flush();
    wanted = false; // e.g. the planted photo was replaced, or my turn ended
    await advance(1000);
    expect(await outcome).toBeInstanceOf(UploadAbandonedError);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("an upload that throws UploadAbandonedError is final", async () => {
    const upload = jest.fn().mockRejectedValue(new UploadAbandonedError());
    const outcome = await uploadWithRetry("file:///p.jpg", upload, OPTIONS).catch((e) => e);
    expect(outcome).toBeInstanceOf(UploadAbandonedError);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// EXP-076: the turn photo's waits are bounded by the photo wait the server gave, not a fixed 15 s
describe("turnUploadRetry", () => {
  it.each([
    [15_000, 7_500], // the full photo wait
    [5_000, 2_500], // what a resume leaves of it at least
    [60_000, TURN_UPLOAD_RETRY.maxTotalWaitMs], // never more than the turn defaults
  ])("a %i ms photo wait allows %i ms of waits in total", (photoWaitMs, totalMs) => {
    expect(turnUploadRetry(photoWaitMs)).toEqual({ ...TURN_UPLOAD_RETRY, maxTotalWaitMs: totalMs });
  });

  it("an unknown photo wait keeps the turn defaults", () => {
    expect(turnUploadRetry(0)).toBe(TURN_UPLOAD_RETRY);
  });

  it("a 5 s wait stops retrying a failing upload after 1 s of waits (the next 2 s would pass half the wait)", async () => {
    const upload = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, turnUploadRetry(5_000)).catch((e) => e);
    await flush();
    await advance(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("a busy server's Retry-After longer than what is left of the wait ends the retries at once", async () => {
    const upload = jest.fn().mockRejectedValue(busy(503, 3000));
    const outcome = await uploadWithRetry("file:///p.jpg", upload, turnUploadRetry(5_000)).catch((e) => e);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 503 });
  });
});

describe("parseRetryAfterMs", () => {
  it.each([
    ["2", 2000],
    ["0", 0],
    ["1800", 1_800_000],
    ["999999", 999_999_000],
    ["1234567", Infinity], // past 6 digits: longer than any wait, give up
    ["99999999999999999999999", Infinity],
    [null, null],
    ["", null],
    ["soon", null],
    ["-3", null],
    ["2.5", null],
    [" 2", null],
    ["Wed, 21 Oct 2026 07:28:00 GMT", null], // the server only sends seconds
  ])("%p -> %p", (header, ms) => {
    expect(parseRetryAfterMs(header)).toBe(ms);
  });
});
