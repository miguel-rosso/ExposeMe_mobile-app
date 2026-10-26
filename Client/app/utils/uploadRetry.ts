// ── Retried upload of my turn's photo ──

export interface UploadRetryOptions {
  /** Uploads tried in total before giving up. */
  attempts: number;
  /** Wait before retry n is backoffMs * n (linear backoff); none after the last attempt. */
  backoffMs: number;
}

export const TURN_UPLOAD_RETRY: UploadRetryOptions = { attempts: 3, backoffMs: 1000 };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uploads the photo at `uri` with `upload`, retrying failures with a linear backoff.
 * Returns the uploaded photo's server path; throws the last error once every attempt has failed.
 */
export const uploadWithRetry = async (
  uri: string,
  upload: (uri: string) => Promise<string>,
  { attempts, backoffMs }: UploadRetryOptions = TURN_UPLOAD_RETRY,
): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`Upload attempt ${attempt}...`);
      const url = await upload(uri);
      console.log("Photo uploaded");
      return url;
    } catch (e) {
      console.error(`Attempt ${attempt} failed:`, e);
      lastError = e;
      if (attempt < attempts) await wait(backoffMs * attempt);
    }
  }
  console.error("All upload attempts failed");
  throw lastError;
};
