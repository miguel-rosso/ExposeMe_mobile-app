/** Photo upload for `your-turn` request `attempt`, which the server re-sends after a reconnect or a pause. */
export interface TurnUpload {
  attempt: number;
  url?: string;
}

/**
 * What to do on `your-turn` for request `attempt`: "upload" a new photo, "resend" the already uploaded `url`
 * (a photo-sent emitted while offline or paused was dropped), or "wait" for the upload in flight.
 * A new request (new attempt, even with the same round number after a skip) always uploads again.
 */
export const turnUploadAction = (prev: TurnUpload | null, attempt: number): "upload" | "resend" | "wait" => {
  if (!prev || prev.attempt !== attempt) return "upload";
  return prev.url ? "resend" : "wait";
};

/** "4:59" style countdown text, rounded up so it never shows 0:00 before the end. */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};
