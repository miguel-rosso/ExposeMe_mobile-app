import { GamePhotoResult, PhotoUnavailableReason } from "@/app/models/interfaces";
import type { RoundView } from "./roundState";
import { PhotoConversionError, turnUploadRetry, uploadWithRetry } from "./uploadRetry";

// ── My turn's photo: pick, upload, and pick another if one can't be converted ──

/**
 * Photos picked in total for one turn. A photo that can't be converted (corrupt, unsupported format) fails the same
 * way on every attempt, so another one is picked instead of skipping the round (EXP-292); past this many, the gallery
 * is likely the problem and the turn is reported unavailable.
 */
export const MAX_TURN_PHOTO_PICKS = 3;

/** The server's photo wait as last given: `key` changes whenever a resume or rejoin restarts it with `durationMs` left. */
export interface PhotoWait {
  key: number;
  durationMs: number;
}

/** The photo wait the round view shows (its phase key and what the server left of it), null outside waiting-photo. */
export const photoWaitOf = ({ phase, phaseKey, phaseDuration }: RoundView): PhotoWait | null =>
  phase === "waiting-photo" ? { key: phaseKey, durationMs: phaseDuration } : null;

export interface TurnPhotoDeps {
  /**
   * Picks a gallery photo not sent yet this game. The picker doesn't repeat one while photos not sent this game
   * remain; once the gallery is used up it may hand out the same one again.
   */
  pick: () => Promise<GamePhotoResult>;
  /** Converts and uploads one photo; returns its server path. */
  upload: (uri: string) => Promise<string>;
  /** Whether the turn still wants a photo: checked before each pick and each upload attempt. */
  stillWanted: () => boolean;
  /** The server's current photo wait (read again on every check), null when unknown. */
  photoWait: () => PhotoWait | null;
  /** The game is paused: the server's wait is frozen, so it is never over meanwhile. */
  paused: () => boolean;
  now?: () => number;
}

export type TurnPhotoResult = { url: string } | { error: PhotoUnavailableReason };

/**
 * Time left of the server's photo wait, in ms (null when unknown), counted from now. Restarts from the server's
 * `durationMs` whenever the wait's key changes (a resume or rejoin gave what is left of it), so a pause never eats
 * into it.
 */
const photoWaitClock = (photoWait: () => PhotoWait | null, now: () => number) => {
  let key: number | null = null;
  let deadline = 0;
  const remainingMs = (): number | null => {
    const wait = photoWait();
    if (!wait || !(wait.durationMs > 0)) return null;
    if (wait.key !== key) {
      key = wait.key;
      deadline = now() + wait.durationMs;
    }
    return deadline - now();
  };
  remainingMs();
  return remainingMs;
};

/**
 * My turn's photo, uploaded: picks a photo and uploads it with retries bounded by the server's photo wait. A photo
 * that can't be converted is replaced by another pick (up to MAX_TURN_PHOTO_PICKS) while the turn still wants it and
 * the server's wait isn't over, each upload's retries bounded by what is left of that wait. Resolves with the uploaded
 * photo's path, or the reason to report the turn unavailable.
 */
export const pickAndUploadTurnPhoto = async ({
  pick, upload, stillWanted, photoWait, paused, now = Date.now,
}: TurnPhotoDeps): Promise<TurnPhotoResult> => {
  const remainingWaitMs = photoWaitClock(photoWait, now);
  const waitOver = () => {
    const leftMs = remainingWaitMs();
    return !paused() && leftMs !== null && leftMs <= 0;
  };
  for (let picks = 1; ; picks++) {
    const picked = await pick();
    if ("error" in picked) return picked;
    if (waitOver()) return { error: "upload" };
    // What is left of the server's wait bounds this photo's retries (unknown, or frozen by a pause: default retries)
    const retry = turnUploadRetry(remainingWaitMs() ?? 0);
    try {
      return { url: await uploadWithRetry(picked.uri, upload, retry, stillWanted) };
    } catch (e) {
      const canPickAgain = e instanceof PhotoConversionError && picks < MAX_TURN_PHOTO_PICKS
        && stillWanted() && !waitOver();
      if (!canPickAgain) return { error: "upload" };
      console.log("Photo can't be converted, picking another one");
    }
  }
};
