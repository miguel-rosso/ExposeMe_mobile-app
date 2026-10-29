import { PhotoUnavailableReason, RoundSkippedData } from "../models/interfaces";

// ── Waiting for the chosen player's photo (see Server/GAME_FLOW.md "Waiting for the photo") ──

/**
 * Notice shown on the waiting screen after a skipped round: the room's, which never says why (EXP-110), or my own
 * when it was my turn.
 */
export type SkipNotice = "skipped" | "own-timeout" | `own-${PhotoUnavailableReason}`;

const SKIP_TEXT_KEYS = {
  skipped: "roundSkipped",
  "own-timeout": "ownPhotoTimeout",
  "own-permission": "ownPhotoNoPermission",
  "own-no-photos": "ownPhotoNoPhotos",
  "own-failed": "ownPhotoFailed",
  "own-upload": "ownPhotoUploadFailed",
} as const;

type SkipTextKey = (typeof SKIP_TEXT_KEYS)[SkipNotice];

/**
 * `round-skipped`: only my own copy (the round was my turn) has a reason. My photo didn't arrive in time, or I reported
 * photo-unavailable and show why; everything else gets the room's notice.
 */
export const skipNoticeFor = (data: RoundSkippedData, ownReason: PhotoUnavailableReason | null): SkipNotice => {
  if (data.reason === "timeout") return "own-timeout";
  if (data.reason === "unavailable" && ownReason) return `own-${ownReason}`;
  return "skipped";
};

export const skipNoticeText = (t: Record<SkipTextKey, string>, notice: SkipNotice): string => t[SKIP_TEXT_KEYS[notice]];
