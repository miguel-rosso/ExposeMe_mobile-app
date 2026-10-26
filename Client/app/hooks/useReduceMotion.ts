import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Whether the system asks apps to reduce motion (iOS "Reduce Motion", Android "Remove animations"), kept up to date */
export const useReduceMotion = () => {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (active) setReduceMotion(enabled); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
};
