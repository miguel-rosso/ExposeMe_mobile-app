// ── Screen retries ──
// The error screen's Retry (components/ErrorScreen) renders the screen that failed again: a new mount of the same
// route, whose own state starts over. It marks the retry here, by route name, so that mount can tell itself apart from
// the route's first mount (e.g. the game screen, which missed the events of the phase in play, asks for the server's
// snapshot again). The mark lives until the retried screen mounts or the error screen shows again (the retry failed).

let retriedRoute: string | null = null;

/** Retry was tapped on the error screen of route `routeName` (its name in the root stack, e.g. "screens/GameScreen") */
export const markScreenRetry = (routeName: string): void => {
  retriedRoute = routeName;
};

/** No retry pending any more: the retried screen mounted, or failed again (its error screen is back) */
export const forgetScreenRetry = (): void => {
  retriedRoute = null;
};

/** Whether a retry of route `routeName` is pending, i.e. a mount of that route now is the retry's */
export const isScreenRetry = (routeName: string): boolean => retriedRoute === routeName;
