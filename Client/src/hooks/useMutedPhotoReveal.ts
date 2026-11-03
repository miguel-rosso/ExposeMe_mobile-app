import { useCallback, useRef, useState } from "react";

/**
 * Whether the round photo on screen is covered as a muted player's (EXP-422), and `show` (stable, for the memoised
 * scoreboard) to reveal it: for that photo only, so their next one is covered again.
 */
export const useMutedPhotoReveal = (photo: string | null, ownerMuted: boolean) => {
  const [shownPhoto, setShownPhoto] = useState<string | null>(null);
  const photoRef = useRef(photo);
  photoRef.current = photo;
  const show = useCallback(() => setShownPhoto(photoRef.current), []);
  return { covered: ownerMuted && photo !== null && shownPhoto !== photo, show };
};
