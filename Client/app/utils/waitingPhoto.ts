import { PhotoUnavailableReason, RoundSkippedData, WaitingPhotoData } from "../models/interfaces";
import { RoundStartSetters } from "./roundStart";

// ── Waiting for the chosen player's photo (see Server/GAME_FLOW.md "Waiting for the photo") ──

/** Notice shown on the waiting screen after a skipped round: the room's reason, or my own if it was my turn */
export type SkipNotice = RoundSkippedData["reason"] | `own-${PhotoUnavailableReason}`;

const SKIP_TEXT_KEYS = {
  timeout: "roundSkippedTimeout",
  unavailable: "roundSkippedUnavailable",
  "own-permission": "ownPhotoNoPermission",
  "own-no-photos": "ownPhotoNoPhotos",
  "own-failed": "ownPhotoFailed",
  "own-upload": "ownPhotoUploadFailed",
} as const;

type SkipTextKey = (typeof SKIP_TEXT_KEYS)[SkipNotice];

/**
 * `waiting-photo` (and a `game-state` in that phase): leave the previous round's photo and scores and show the
 * waiting screen for round `round`, with the server's `duration` for the progress bar.
 */
export const applyWaitingPhoto = (data: WaitingPhotoData, s: RoundStartSetters) => {
  s.setPhoto(null);
  s.setIsOwner(false);
  s.setRound(data.round);
  s.setPhase("waiting-photo");
  s.setPhaseDuration(data.duration);
  s.setPhaseKey((k) => k + 1);
  s.setCorrectAnswer("");
  s.setScores(null);
  s.setMySelection("");
  s.setGameHeld(false);
  s.setPressing(false);
};

/** `round-skipped`: my own reason when I reported photo-unavailable for this round, otherwise the room's. */
export const skipNoticeFor = (data: RoundSkippedData, ownReason: PhotoUnavailableReason | null): SkipNotice =>
  ownReason && data.reason === "unavailable" ? `own-${ownReason}` : data.reason;

export const skipNoticeText = (t: Record<SkipTextKey, string>, notice: SkipNotice): string => t[SKIP_TEXT_KEYS[notice]];
