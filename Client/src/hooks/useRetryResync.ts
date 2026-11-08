import { useEffect, useRef, useState } from "react";
import { forgetScreenRetry, isScreenRetry } from "../utils/screenRetry";

/**
 * Least time between two retry resyncs. Each one is a join on the same socket, and the server takes at most 5 joins
 * per socket in any 10 s: past that it answers "Too many attempts", which sends the game screen home (Server/GAME_FLOW.md,
 * "Join, rejoin and session"). One per window keeps a Retry tapped over and over (a screen that fails again right after
 * the snapshot) well under it; a retry within the window waits for the next phase's events instead.
 */
export const RETRY_RESYNC_INTERVAL_MS = 10_000;

/** Device time of the last retry resync: module-wide, as every retry mounts a new screen instance */
let lastResyncAt = -Infinity;

/**
 * For a screen the error screen's Retry may mount again on the same route (see utils/screenRetry): whether this mount is
 * that retry, and if so, once it has mounted, `resync()` to ask the server again for what the screen missed. A render
 * that fails again commits nothing, so a Retry that keeps failing sends nothing.
 */
export const useRetryResync = (routeName: string, resync: () => void): boolean => {
  // Decided once, while rendering: the screen's first frame already knows it (e.g. a loader until the snapshot)
  const [retried] = useState(() => isScreenRetry(routeName));
  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  useEffect(() => {
    if (!retried) return;
    forgetScreenRetry();
    const now = Date.now();
    if (now - lastResyncAt < RETRY_RESYNC_INTERVAL_MS) return;
    lastResyncAt = now;
    resyncRef.current();
  }, []);

  return retried;
};

export default useRetryResync;
