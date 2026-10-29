import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

// ── Module-level cache of the system setting ──
// Asked once and then kept current by the system's change event, so every mount after the first answer reads it
// synchronously: a component that mounts already on screen (the scoreboard on rejoin) never animates on a stale false.

type Subscription = { remove: () => void };

let cachedSetting: boolean | undefined;
let systemSubscription: Subscription | undefined;
const subscribers = new Set<() => void>();

const publishSetting = (enabled: boolean) => {
  cachedSetting = enabled;
  subscribers.forEach((notify) => notify());
};

/** Starts watching the system setting the first time anyone needs it; the watch lasts for the app's lifetime */
const watchSystemSetting = () => {
  if (systemSubscription) return;
  const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", publishSetting);
  systemSubscription = subscription;
  // A change event that beats the first answer is newer, so the answer only fills an empty cache.
  // A reset (tests) replaces the subscription, which discards the answers still in flight from the old one.
  const answer = (enabled: boolean) => {
    if (systemSubscription === subscription && cachedSetting === undefined) publishSetting(enabled);
  };
  AccessibilityInfo.isReduceMotionEnabled()
    .then(answer)
    // Unknown setting: animate as usual rather than waiting forever
    .catch(() => answer(false));
};

const subscribe = (notify: () => void) => {
  watchSystemSetting();
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
};

const readSetting = () => cachedSetting;

/** Forgets the cached setting and stops watching the system, so each test starts from a cold app */
export const resetReduceMotionSettingForTests = () => {
  systemSubscription?.remove();
  systemSubscription = undefined;
  cachedSetting = undefined;
  subscribers.clear();
};

// ── Hooks ──

/**
 * Whether the system asks apps to reduce motion (iOS "Reduce Motion", Android "Remove animations"), kept up to date.
 * Undefined until the system first answers (cold start only): lets an entrance animation wait for it instead of
 * starting and then jumping.
 */
export const useReduceMotionSetting = (): boolean | undefined => useSyncExternalStore(subscribe, readSetting);

/** Whether the system asks apps to reduce motion; false until the system first answers */
export const useReduceMotion = () => useReduceMotionSetting() ?? false;
