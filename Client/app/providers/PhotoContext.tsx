import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from "react";
import * as MediaLibrary from "expo-media-library";
import { GamePhotoResult, PhotoContextProps, PhotoProviderProps } from "@/app/models/interfaces";
import { checkGalleryAccess as checkAccess, GalleryAccess, isLimitedPermission } from "@/app/utils/galleryAccess";
import { createRandomPhotoPicker } from "@/app/utils/randomGalleryPhoto";

/** Id of the visible image at `offset`: a one-row query, never a full gallery read (EXP-174) */
const photoIdAt = async (offset: number): Promise<string | null> => {
  const page = await new MediaLibrary.Query()
    .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
    .offset(offset)
    .limit(1)
    .exeForMetadata();
  return page[0]?.id ?? null;
};

const PhotoContext = createContext<PhotoContextProps | undefined>(undefined);

export const PhotoProvider: React.FC<PhotoProviderProps> = ({ children }) => {
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  /** Photo permission granted, full or limited access. Never navigates: callers explain what is missing. */
  const requestGalleryPermission = useCallback(async ({ askAgain }: { askAgain: boolean }): Promise<boolean> => {
    let { status, canAskAgain } = await MediaLibrary.getPermissionsAsync();
    if (status !== "granted" && canAskAgain && askAgain) ({ status } = await MediaLibrary.requestPermissionsAsync());
    console.log(`Gallery permission: ${status}`);
    return status === "granted";
  }, []);

  /** Whether at least one image is visible to the app (the limited selection counts) */
  const hasVisiblePhotos = useCallback(async (): Promise<boolean> => {
    const photos = await new MediaLibrary.Query()
      .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
      .limit(1)
      .exeForMetadata();
    return photos.length > 0;
  }, []);

  /** Gate to play: permission (full or limited) and at least one visible photo. `ask` shows the system prompt if it can. */
  const checkGalleryAccess = useCallback(
    ({ ask }: { ask: boolean }): Promise<GalleryAccess> =>
      checkAccess(
        {
          getPermissions: () => MediaLibrary.getPermissionsAsync(),
          requestPermissions: () => MediaLibrary.requestPermissionsAsync(),
          hasPhotos: hasVisiblePhotos,
        },
        { ask }
      ),
    [hasVisiblePhotos]
  );

  /** Only part of the gallery is shared. Reads the permission only: no prompt, no photo query. */
  const isLimitedAccess = useCallback(
    async (): Promise<boolean> => isLimitedPermission(await MediaLibrary.getPermissionsAsync()),
    []
  );

  /** Limited access: lets the user share more photos (iOS 14+, Android 14+); does nothing elsewhere. */
  const selectMorePhotos = useCallback(async () => {
    try {
      await MediaLibrary.presentPermissionsPicker(["photo"]);
    } catch (e) {
      console.log("Photo selection picker unavailable:", e);
    }
  }, []);

  /**
   * Gallery or limited selection changed (iOS reports picks made in the limited picker this way: the picker call
   * itself resolves as soon as it opens). Returns the unsubscribe function.
   */
  const onGalleryChange = useCallback((listener: () => void): (() => void) => {
    try {
      const sub = MediaLibrary.addListener(() => listener());
      return () => sub.remove();
    } catch (e) {
      console.log("Gallery change listener unavailable:", e);
      return () => {};
    }
  }, []);

  /** Onboarding: show the system prompt. Home's Create/Join gate explains anything still missing. */
  const handleContinue = useCallback(async () => {
    try {
      const { status, accessPrivileges } = await MediaLibrary.requestPermissionsAsync();
      console.log(`Onboarding permission: ${status} (${accessPrivileges})`);
    } catch (e) {
      console.log("Could not request gallery permission:", e);
    }
  }, []);

  // Image count cached across turns; dropped when the gallery or the limited selection changes. The change
  // listener is only registered once a photo is first picked, and removed on unmount.
  const [picker] = useState(() => createRandomPhotoPicker(photoIdAt));
  const pickerSubRef = useRef<{ remove: () => void } | null>(null);
  useEffect(() => () => pickerSubRef.current?.remove(), []);

  /** Random photo among the ones the app can see (all of them, or the limited selection), not repeated within a game. */
  const pickFromGallery = useCallback(async (): Promise<GamePhotoResult> => {
    if (!pickerSubRef.current) {
      try {
        pickerSubRef.current = MediaLibrary.addListener(() => picker.invalidate());
      } catch (e) {
        console.log("Gallery change listener unavailable:", e);
        pickerSubRef.current = { remove: () => {} };
      }
    }
    // Retry up to 3 times if the picked asset can't be resolved to a file URI
    for (let i = 0; i < 3; i++) {
      const id = await picker.pick();
      if (id === null) {
        console.log("No photos on device.");
        return { error: "no-photos" };
      }
      console.log(`Selected photo: ${id}`);

      let uri: string | null = null;
      try {
        uri = await new MediaLibrary.Asset(id).getUri();
      } catch (e) {
        console.log("Could not resolve photo URI:", e);
      }

      if (uri) {
        const encodedUri = encodeURI(uri);
        console.log("Random photo selected.");
        setPhotoUri(encodedUri);
        return { uri: encodedUri };
      }
    }

    console.log("Failed to select a photo after retries.");
    return { error: "failed" };
  }, [picker]);

  /** A new game starts: photos sent in earlier games may come up again (no repeats within a game, EXP-162). */
  const resetUsedPhotos = useCallback(() => picker.reset(), [picker]);

  const getRandomPhoto = useCallback(async (): Promise<string | null> => {
    console.log("Getting random photo...");
    const hasPermission = await requestGalleryPermission({ askAgain: true });
    if (!hasPermission) {
      console.log("No permission to access gallery.");
      return null;
    }
    const result = await pickFromGallery();
    return "uri" in result ? result.uri : null;
  }, [requestGalleryPermission, pickFromGallery]);

  /**
   * In-game photo for `your-turn`. Never navigates (leaving the game screen would drop the player from the
   * game) and never asks for permission: a system prompt only on this phone would tell the player the next photo
   * is theirs (EXP-252). Uses whatever photos are accessible, limited access included. Reports why when there is
   * no photo to send.
   */
  const pickGamePhoto = useCallback(async (): Promise<GamePhotoResult> => {
    try {
      const { status } = await MediaLibrary.getPermissionsAsync();
      if (status !== "granted") {
        console.log(`No gallery permission in game (${status}).`);
        return { error: "permission" };
      }
      return await pickFromGallery();
    } catch (e) {
      console.log("Could not pick a game photo:", e);
      return { error: "failed" };
    }
  }, [pickFromGallery]);

  const contextValue = useMemo(
    () => ({
      photoUri,
      requestGalleryPermission,
      getRandomPhoto,
      pickGamePhoto,
      checkGalleryAccess,
      isLimitedAccess,
      selectMorePhotos,
      onGalleryChange,
      setPhotoUri,
      handleContinue,
      resetUsedPhotos,
    }),
    [
      photoUri,
      requestGalleryPermission,
      getRandomPhoto,
      pickGamePhoto,
      checkGalleryAccess,
      isLimitedAccess,
      selectMorePhotos,
      onGalleryChange,
      handleContinue,
      resetUsedPhotos,
    ]
  );

  return <PhotoContext.Provider value={contextValue}>{children}</PhotoContext.Provider>;
};

// Hook para usar el contexto de fotos
export const usePhotoContext = () => {
  const context = useContext(PhotoContext);
  if (!context) {
    throw new Error("usePhotoContext must be used within a PhotoProvider");
  }
  return context;
};

export default PhotoProvider;
