import { useEffect, useRef } from "react";
import { Animated, Keyboard, Platform } from "react-native";

/** How long the padding takes to follow the iOS keyboard as it slides in and out */
const IOS_KEYBOARD_SHOW_MS = 250;
const IOS_KEYBOARD_HIDE_MS = 200;

/**
 * Bottom padding that follows the keyboard's height, for content that must stay above it. The window does not shrink
 * for the keyboard (iOS never does; Android draws the app edge to edge), so screens add this themselves: on iOS it
 * slides with the keyboard (will-show / will-hide); Android only reports the keyboard once shown, so it jumps there.
 */
export const useKeyboardPadding = (): Animated.Value => {
  const padding = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const ios = Platform.OS === "ios";
    const follow = (height: number, durationMs: number) => {
      if (ios) Animated.timing(padding, { toValue: height, duration: durationMs, useNativeDriver: false }).start();
      else padding.setValue(height);
    };
    const showListener = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) =>
      follow(e.endCoordinates.height, IOS_KEYBOARD_SHOW_MS)
    );
    const hideListener = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      follow(0, IOS_KEYBOARD_HIDE_MS)
    );
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, [padding]);

  return padding;
};
