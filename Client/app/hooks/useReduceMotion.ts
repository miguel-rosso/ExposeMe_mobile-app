import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Whether the system asks apps to reduce motion (iOS "Reduce Motion", Android "Remove animations"), kept up to date.
 * Undefined until the system answers: lets an entrance animation wait for it instead of starting and then jumping.
 */
export const useReduceMotionSetting = (): boolean | undefined => {
  const [reduceMotion, setReduceMotion] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (active) setReduceMotion(enabled); })
      // Unknown setting: animate as usual rather than waiting forever
      .catch(() => { if (active) setReduceMotion(false); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
};

/** Whether the system asks apps to reduce motion; false until the system answers */
export const useReduceMotion = () => useReduceMotionSetting() ?? false;
