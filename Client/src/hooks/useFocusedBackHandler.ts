import { useCallback, useEffect, useRef } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";

/**
 * Android back (the key and the back gesture), only while this screen is focused: a screen kept mounted under
 * another one (e.g. home under the waiting room) never takes a press meant for the screen on top (EXP-339).
 * `handler` returns true when it consumed the press, false to let the default run (e.g. leave the app).
 */
export const useFocusedBackHandler = (handler: () => boolean) => {
  // The latest handler, so a re-render never re-subscribes it (that would put it ahead of other screens' handlers)
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => handlerRef.current());
      return () => subscription.remove();
    }, [])
  );
};

export default useFocusedBackHandler;
