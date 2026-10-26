// ── Retried photo upload (my turn's photo, the planted photo) ──

export interface UploadRetryOptions {
  /** Uploads tried in total before giving up. */
  attempts: number;
  /** Wait before retry n is at least backoffMs * n (linear backoff, capped at maxWaitMs), or the Retry-After if longer. */
  backoffMs: number;
  /** Longest single wait. A Retry-After beyond it ends the retries: the server is busy for longer than that. */
  maxWaitMs: number;
  /** The waits never add up to more than this. */
  maxTotalWaitMs: number;
}

/**
 * The turn photo must arrive within the server's 15 s photo wait (PHOTO_WAIT_TIMEOUT): at most 8 s of waits (1 s, 2 s,
 * 3 s, or a busy server's 2 s Retry-After) leaves the rest to pick the photo and run the uploads.
 */
export const TURN_UPLOAD_RETRY: UploadRetryOptions = { attempts: 4, backoffMs: 1000, maxWaitMs: 5000, maxTotalWaitMs: 8000 };

/** The planted photo is sent from the lobby, with no deadline: more patience, but "planted" only shows once it's in. */
export const PLANT_UPLOAD_RETRY: UploadRetryOptions = { attempts: 6, backoffMs: 1000, maxWaitMs: 5000, maxTotalWaitMs: 20_000 };

/** Refusals worth retrying: timeout, rate limited / too many uploads in flight, busy or storage full. */
const RETRYABLE_STATUSES = [408, 429, 503];
/** Random extra wait, so players refused at once don't all retry at once: up to min(1 s, half the wait). */
const MAX_JITTER_MS = 1000;
/** Retry-After as whole seconds, at most 6 digits; longer numbers are treated as "too long to wait". */
const RETRY_AFTER_SECONDS_RE = /^\d{1,6}$/;
const RETRY_AFTER_TOO_LONG_RE = /^\d{7,}$/;

/** A refused upload: the HTTP status and the server's Retry-After, if any. */
export class UploadHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`Upload failed: ${status}`);
    this.name = "UploadHttpError";
  }
}

/** The upload is no longer wanted (photo replaced, turn over): never retried. */
export class UploadAbandonedError extends Error {
  constructor() {
    super("Upload no longer wanted");
    this.name = "UploadAbandonedError";
  }
}

/**
 * Retry-After header in ms: null when absent or not whole seconds (the server never sends a date), Infinity when it
 * is too long a number to be a sensible wait (gives up).
 */
export const parseRetryAfterMs = (header: string | null): number | null => {
  if (header === null) return null;
  if (RETRY_AFTER_SECONDS_RE.test(header)) return Number(header) * 1000;
  return RETRY_AFTER_TOO_LONG_RE.test(header) ? Infinity : null;
};

/** Only network errors (no response) and the RETRYABLE_STATUSES are worth another attempt. */
const isRetryable = (error: unknown): boolean => {
  if (error instanceof UploadAbandonedError) return false;
  return !(error instanceof UploadHttpError) || RETRYABLE_STATUSES.includes(error.status);
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait before retry `attempt` + 1 after `error`, or null when retrying is pointless (a final error, or the server
 * asked to wait longer than maxWaitMs) or the wait would take the total past maxTotalWaitMs.
 */
const nextWaitMs = (
  error: unknown,
  attempt: number,
  waitedMs: number,
  { backoffMs, maxWaitMs, maxTotalWaitMs }: UploadRetryOptions,
): number | null => {
  if (!isRetryable(error)) return null;
  const retryAfterMs = error instanceof UploadHttpError ? error.retryAfterMs ?? 0 : 0;
  if (retryAfterMs > maxWaitMs) return null;
  const baseMs = Math.max(retryAfterMs, Math.min(backoffMs * attempt, maxWaitMs));
  const budgetLeftMs = maxTotalWaitMs - waitedMs;
  if (baseMs > budgetLeftMs) return null;
  const jitterMs = Math.random() * Math.min(MAX_JITTER_MS, baseMs / 2);
  return Math.round(Math.min(baseMs + jitterMs, maxWaitMs, budgetLeftMs));
};

/**
 * Uploads the photo at `uri` with `upload`, retrying network errors and a busy server (RETRYABLE_STATUSES) after its
 * Retry-After or a linear backoff. Stops with an UploadAbandonedError as soon as `shouldContinue` says the upload is
 * no longer wanted (checked before each attempt). Returns the uploaded photo's server path; throws the last error once
 * it gives up.
 * Failures are only console.log'ged: development builds show errors/warnings as a toast on the phone, which would
 * tell the photo owner it's their turn (EXP-252).
 */
export const uploadWithRetry = async (
  uri: string,
  upload: (uri: string) => Promise<string>,
  options: UploadRetryOptions = TURN_UPLOAD_RETRY,
  shouldContinue: () => boolean = () => true,
): Promise<string> => {
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    if (!shouldContinue()) {
      console.log("Upload no longer wanted");
      throw new UploadAbandonedError();
    }
    try {
      console.log(`Upload attempt ${attempt}...`);
      const url = await upload(uri);
      console.log("Photo uploaded");
      return url;
    } catch (e) {
      console.log(`Attempt ${attempt} failed:`, e);
      const waitMs = attempt < options.attempts ? nextWaitMs(e, attempt, waitedMs, options) : null;
      if (waitMs === null) {
        console.log("Upload given up");
        throw e;
      }
      waitedMs += waitMs;
      await wait(waitMs);
    }
  }
};
