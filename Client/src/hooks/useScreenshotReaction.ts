import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as ScreenCapture from "expo-screen-capture";
import type { Socket } from "socket.io-client";
import { SCREENSHOT_EMOJI } from "../utils/reactions";
import { emitWhileConnected } from "../utils/socketEmit";

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
      // Offline it is dropped, not buffered: the server would drop it before the rejoin anyway
      if (emitWhileConnected(socket, "emoji-reaction", { emoji: SCREENSHOT_EMOJI })) lastSentRef.current = now;
    });
    return () => subscription.remove();
  }, [socket]);
}
