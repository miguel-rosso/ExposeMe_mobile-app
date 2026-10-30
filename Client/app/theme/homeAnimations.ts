import * as Animatable from "react-native-animatable";
import type { CustomAnimation } from "react-native-animatable";

// ── Custom react-native-animatable animations of the home screen (app/index.tsx) ──

/** Duration of the home screen's enter / bounce animations */
export const HOME_ANIMATION_MS = 600;
/** Duration of the shake that rejects a blank name or an incomplete room code */
export const SHAKE_MS = 500;

/** The join panel's code input (and its name input, for an invite): fades in from above with a bounce */
const SLIDE_IN_DOWN_BOUNCE: CustomAnimation = {
  0: { opacity: 0, translateY: -15 },
  0.6: { opacity: 1, translateY: 10 },
  0.75: { opacity: 1, translateY: -5 },
  0.9: { opacity: 1, translateY: 2 },
  1: { opacity: 1, translateY: 0 },
};

/** The join panel's Search button: fades in from below with a bounce */
const SLIDE_IN_UP_BOUNCE: CustomAnimation = {
  0: { opacity: 0, translateY: 15 },
  0.6: { opacity: 1, translateY: -10 },
  0.75: { opacity: 1, translateY: 5 },
  0.9: { opacity: 1, translateY: -2 },
  1: { opacity: 1, translateY: 0 },
};

/** The name input reappearing after the join panel closes: fades in bouncing upwards */
export const REAPPEAR_BOUNCE_UP: CustomAnimation = {
  0: { opacity: 0, translateY: 0 },
  0.25: { opacity: 1, translateY: -10 },
  0.5: { opacity: 1, translateY: -5 },
  0.75: { opacity: 1, translateY: 5 },
  1: { opacity: 1, translateY: 0 },
};

/** The Join game button reappearing after the join panel closes: fades in bouncing downwards */
export const REAPPEAR_BOUNCE_DOWN: CustomAnimation = {
  0: { opacity: 0, translateY: 0 },
  0.25: { opacity: 1, translateY: 10 },
  0.5: { opacity: 1, translateY: 5 },
  0.75: { opacity: 1, translateY: -5 },
  1: { opacity: 1, translateY: 0 },
};

// Leaving for the photo explorer and coming back (useExitAnimationNavigation steps)
const SLIDE_OUT_DOWN_FAR: CustomAnimation = {
  0: { opacity: 1, translateY: 0 },
  1: { opacity: 0, translateY: 100 },
};
const SLIDE_OUT_UP_FAR: CustomAnimation = {
  0: { opacity: 1, translateY: 0 },
  1: { opacity: 0, translateY: -200 },
};
const SLIDE_IN_DOWN_FAR: CustomAnimation = {
  0: { opacity: 0, translateY: -200 },
  1: { opacity: 1, translateY: 0 },
};

/**
 * Registers the animations the home screen refers to by name: through the `animation` prop, and in the exit steps
 * of useExitAnimationNavigation. Call it at module level, before any Animatable view that uses them mounts.
 */
export function registerHomeAnimations() {
  Animatable.initializeRegistryWithDefinitions({
    slideInDownBounce: SLIDE_IN_DOWN_BOUNCE,
    slideInUpBounce: SLIDE_IN_UP_BOUNCE,
    slideOutDownFar: SLIDE_OUT_DOWN_FAR,
    slideOutUpFar: SLIDE_OUT_UP_FAR,
    slideInDownFar: SLIDE_IN_DOWN_FAR,
  });
}
