import { TURN_UPLOAD_RETRY, uploadWithRetry } from "../app/utils/uploadRetry";

// EXP-232: the turn photo's retried upload, extracted from GameScreen with the same values (3 attempts, 1 s * n)

beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("uploadWithRetry", () => {
  it("keeps the turn defaults: 3 attempts, linear 1 s backoff", () => {
    expect(TURN_UPLOAD_RETRY).toEqual({ attempts: 3, backoffMs: 1000 });
  });

  it("returns the first successful upload without waiting", async () => {
    const upload = jest.fn().mockResolvedValue("/temp/a.jpg");
    await expect(uploadWithRetry("file:///p.jpg", upload)).resolves.toBe("/temp/a.jpg");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("file:///p.jpg");
  });

  it("retries after backoffMs * n and succeeds on a later attempt", async () => {
    const upload = jest.fn().mockRejectedValueOnce(new Error("500")).mockResolvedValue("/temp/b.jpg");
    const result = uploadWithRetry("file:///p.jpg", upload);
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(999);
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    await expect(result).resolves.toBe("/temp/b.jpg");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after every attempt failed, with no wait after the last one", async () => {
    const upload = jest.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"));
    const outcome = uploadWithRetry("file:///p.jpg", upload).catch((e) => e);
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(upload).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2000);
    await flush();
    expect(upload).toHaveBeenCalledTimes(3);
    expect((await outcome).message).toBe("third");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("honours custom options", async () => {
    const upload = jest.fn().mockRejectedValue(new Error("x"));
    const outcome = uploadWithRetry("file:///p.jpg", upload, { attempts: 2, backoffMs: 10 }).catch((e) => e);
    await flush();
    jest.advanceTimersByTime(10);
    await flush();
    expect(upload).toHaveBeenCalledTimes(2);
    expect((await outcome).message).toBe("x");
  });
});
