import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { usePhotoContext } from "@/app/providers/PhotoContext";
import type { GalleryAccess } from "@/app/utils/galleryAccess";

const sameAccess = (a: GalleryAccess | null, b: GalleryAccess | null) =>
  a === b || (!!a && !!b && a.status === b.status && a.limited === b.limited && a.canAskAgain === b.canAskAgain);

/**
 * Gallery access needed to play (permission, full or limited, and at least one visible photo).
 * - `watch`: checks on mount and every time the app comes back to the foreground (lobby, game).
 * - otherwise only on `check()`, and on foreground while blocked so the notice clears itself (home).
 * `blocked` is what is missing, or null. Never navigates.
 */
export const useGalleryAccessGuard = ({ watch }: { watch: boolean }) => {
  const { checkGalleryAccess, selectMorePhotos, onGalleryChange } = usePhotoContext();
  const [blocked, setBlocked] = useState<GalleryAccess | null>(null);
  const blockedRef = useRef<GalleryAccess | null>(null);
  const seqRef = useRef(0); // only the latest check may update the state
  const liveRef = useRef(true);
  // Latest context functions without re-subscribing the foreground listener on every render
  const ctxRef = useRef({ checkGalleryAccess, selectMorePhotos, onGalleryChange });
  ctxRef.current = { checkGalleryAccess, selectMorePhotos, onGalleryChange };

  const check = useCallback(async ({ ask }: { ask: boolean }): Promise<GalleryAccess | null> => {
    const seq = ++seqRef.current;
    try {
      const access = await ctxRef.current.checkGalleryAccess({ ask });
      if (liveRef.current && seq === seqRef.current) {
        const next = access.status === "ok" ? null : access;
        if (!sameAccess(blockedRef.current, next)) {
          blockedRef.current = next;
          setBlocked(next);
        }
      }
      return access;
    } catch (e) {
      console.log("Could not check gallery access:", e);
      return null;
    }
  }, []);

  useEffect(() => {
    liveRef.current = true;
    if (watch) check({ ask: false });
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && (watch || blockedRef.current)) check({ ask: false });
    });
    return () => {
      liveRef.current = false;
      sub.remove();
    };
  }, [watch, check]);

  // While blocked: re-check on any gallery / limited selection change (the iOS limited picker resolves as soon as it
  // opens, so the picks made in it only arrive through this listener)
  const isBlocked = blocked !== null;
  useEffect(() => {
    if (!isBlocked) return;
    const { onGalleryChange } = ctxRef.current;
    if (!onGalleryChange) return;
    return onGalleryChange(() => {
      if (blockedRef.current) check({ ask: false });
    });
  }, [isBlocked, check]);

  const dismiss = useCallback(() => {
    seqRef.current++;
    blockedRef.current = null;
    setBlocked(null);
  }, []);

  const selectMore = useCallback(async () => {
    await ctxRef.current.selectMorePhotos();
    await check({ ask: false });
  }, [check]);

  return { blocked, check, dismiss, selectMore };
};
