import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as ScreenCapture from "expo-screen-capture";
import type { Socket } from "socket.io-client";
import { SCREENSHOT_EMOJI } from "../utils/reactions";

const COOLDOWN_MS = 250;

// Tells the room when this player takes a screenshot. Mount once per game (not per round): a single listener,
// removed on unmount or when the socket changes.
export function useScreenshotReaction(socket: Socket | null | undefined) {
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (!socket || (Platform.OS !== "ios" && Platform.OS !== "android")) return;
    const subscription = ScreenCapture.addScreenshotListener(() => {
      const now = Date.now();
      if (now - lastSentRef.current < COOLDOWN_MS) return;
      lastSentRef.current = now;
      socket.emit("emoji-reaction", { emoji: SCREENSHOT_EMOJI });
    });
    return () => subscription.remove();
  }, [socket]);
}
