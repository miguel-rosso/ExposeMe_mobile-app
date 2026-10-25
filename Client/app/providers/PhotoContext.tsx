import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import * as MediaLibrary from "expo-media-library";
import { GamePhotoResult, PhotoContextProps, PhotoProviderProps } from "@/app/models/interfaces";
import { checkGalleryAccess as checkAccess, GalleryAccess } from "@/app/utils/galleryAccess";

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

  /** Random photo among the ones the app can see (all of them, or the limited selection). */
  const pickFromGallery = useCallback(async (): Promise<GamePhotoResult> => {
    // Lightweight metadata of every photo; the file URI is only resolved for the picked one
    const photos = await new MediaLibrary.Query()
      .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
      .exeForMetadata();
    if (photos.length === 0) {
      console.log("No photos on device.");
      return { error: "no-photos" };
    }

    // Retry up to 3 times if the picked asset can't be resolved to a file URI
    for (let i = 0; i < 3; i++) {
      const randomIndex = Math.floor(Math.random() * photos.length);
      console.log(`Selected photo index: ${randomIndex}`);

      let uri: string | null = null;
      try {
        uri = await new MediaLibrary.Asset(photos[randomIndex].id).getUri();
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
  }, []);

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
   * game): it only asks for permission if it was never decided, and uses whatever photos are accessible,
   * limited access included. Reports why when there is no photo to send.
   */
  const pickGamePhoto = useCallback(async (): Promise<GamePhotoResult> => {
    try {
      let { status, canAskAgain } = await MediaLibrary.getPermissionsAsync();
      if (status === "undetermined" && canAskAgain) ({ status } = await MediaLibrary.requestPermissionsAsync());
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
      selectMorePhotos,
      onGalleryChange,
      setPhotoUri,
      handleContinue,
    }),
    [photoUri, requestGalleryPermission, getRandomPhoto, pickGamePhoto, checkGalleryAccess, selectMorePhotos, onGalleryChange, handleContinue]
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
