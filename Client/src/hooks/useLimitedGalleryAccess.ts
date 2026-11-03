import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { usePhotoContext } from "@/src/providers/PhotoContext";

/**
 * Whether only part of the gallery is shared (iOS "Limit access", Android 14+ "Select photos"). Re-checked whenever
 * the screen is focused and, while focused, every time the app comes back to the foreground (access changed in
 * Settings). Never prompts. `addMorePhotos` opens the system picker to share more photos.
 */
export const useLimitedGalleryAccess = () => {
  const { isLimitedAccess, selectMorePhotos } = usePhotoContext();
  const [limited, setLimited] = useState(false);
  const seqRef = useRef(0); // only the latest check may update the state
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const next = await isLimitedAccess();
      if (liveRef.current && seq === seqRef.current) setLimited(next);
    } catch (e) {
      console.log("Could not check limited gallery access:", e);
    }
  }, [isLimitedAccess]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => sub.remove();
    }, [refresh])
  );

  // Android resolves once the picker closes (it may grant full access there); iOS as soon as it opens
  const addMorePhotos = useCallback(async () => {
    await selectMorePhotos();
    await refresh();
  }, [selectMorePhotos, refresh]);

  return { limited, addMorePhotos };
};
