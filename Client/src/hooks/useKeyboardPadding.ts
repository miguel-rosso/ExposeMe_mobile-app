import { useCallback, useRef } from "react";
import { Animated, Keyboard, KeyboardEvent, Platform } from "react-native";
import { useFocusEffect } from "expo-router";

/** How long the padding takes to follow the iOS keyboard as it slides in and out */
const IOS_KEYBOARD_SHOW_MS = 250;
const IOS_KEYBOARD_HIDE_MS = 200;

/** The keyboard's height as React Native last saw it settle (did-show / did-hide), 0 with it hidden */
const settledKeyboardHeight = () => (Keyboard.isVisible() ? Keyboard.metrics()?.height ?? 0 : 0);

/**
 * Bottom padding that follows the keyboard's height, for content that must stay above it. The window does not shrink
 * for the keyboard (iOS never does; Android draws the app edge to edge), so screens add this themselves: on iOS it
 * slides with the keyboard (will-show / will-hide); Android only reports the keyboard once shown, so it jumps there.
 * It follows the keyboard only while its screen is focused: a screen kept mounted under another one (home under the
 * lobby) ignores the keyboard of the screen on top, and catches up with the keyboard as it is once focused again.
 */
export const useKeyboardPadding = (): Animated.Value => {
  const padding = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      const ios = Platform.OS === "ios";
      let target = settledKeyboardHeight();
      padding.setValue(target);
      const follow = (height: number, durationMs: number) => {
        if (height === target) return;
        target = height;
        if (ios) Animated.timing(padding, { toValue: height, duration: durationMs, useNativeDriver: false }).start();
        else padding.setValue(height);
      };
      const followShown = (e: KeyboardEvent) => follow(e.endCoordinates.height, IOS_KEYBOARD_SHOW_MS);
      const followHidden = () => follow(0, IOS_KEYBOARD_HIDE_MS);

      const subscriptions = [
        Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", followShown),
        Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", followHidden),
      ];
      // On iOS a focus that lands while the keyboard slides missed its will-* event, and the settled height read
      // above is still the old one: the did-* event at the end of the slide puts the padding right
      if (ios) {
        subscriptions.push(
          Keyboard.addListener("keyboardDidShow", followShown),
          Keyboard.addListener("keyboardDidHide", followHidden)
        );
      }
      return () => {
        subscriptions.forEach((subscription) => subscription.remove());
        // Losing focus closes this screen's keyboard (or leaves it to the screen on top) after the listeners are
        // gone: drop the padding now, so it isn't left raised under the other screen to jump back on return
        followHidden();
      };
    }, [padding])
  );

  return padding;
};
