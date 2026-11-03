import { RefObject, useCallback, useEffect, useRef } from "react";
import { useFocusEffect, useRouter, Href } from "expo-router";

// ── Leave a screen with an exit animation, and bring its elements back when it regains focus ──

export const SCREEN_EXIT_ANIMATION_MS = 500;

/** An Animatable element and the animations (react-native-animatable names) that hide and show it again. */
export type ExitAnimationStep = {
  ref: RefObject<unknown>;
  exit: string;
  enter: string;
};

type AnimatableHandle = Record<string, ((durationMs?: number) => unknown) | undefined>;

const runAnimation = (ref: RefObject<unknown>, animation: string) =>
  (ref.current as AnimatableHandle | null)?.[animation]?.(SCREEN_EXIT_ANIMATION_MS);

/**
 * Returns `navigateWithExit(path)`: animates every step out, then pushes `path` once the animation ends.
 * The screen stays mounted under the pushed one, so when it is focused again (back) the steps animate back in;
 * otherwise it would be left with its elements hidden. Taps while leaving are ignored (one push per exit), and
 * leaving for another screen before the push fires cancels it.
 */
export function useExitAnimationNavigation(steps: ExitAnimationStep[]) {
  const router = useRouter();
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const hiddenRef = useRef(false);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingPush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = null;
  }, []);

  useEffect(() => cancelPendingPush, [cancelPendingPush]);

  // On focus: bring hidden elements back. On blur (another screen was opened during the exit, e.g. Create game):
  // drop the pending push so it doesn't land on top of that screen; the elements come back on the next focus.
  useFocusEffect(
    useCallback(() => {
      if (hiddenRef.current) {
        hiddenRef.current = false;
        stepsRef.current.forEach(({ ref, enter }) => runAnimation(ref, enter));
      }
      return cancelPendingPush;
    }, [cancelPendingPush])
  );

  return useCallback(
    (path: Href) => {
      if (hiddenRef.current) return;
      hiddenRef.current = true;
      stepsRef.current.forEach(({ ref, exit }) => runAnimation(ref, exit));
      pushTimerRef.current = setTimeout(() => {
        pushTimerRef.current = null;
        router.push(path);
      }, SCREEN_EXIT_ANIMATION_MS);
    },
    [router]
  );
}
