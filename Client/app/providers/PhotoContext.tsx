import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import * as MediaLibrary from "expo-media-library";
import { useRouter } from "expo-router";
import { GamePhotoResult, PhotoContextProps, PhotoProviderProps } from "@/app/models/interfaces";

const PhotoContext = createContext<PhotoContextProps | undefined>(undefined);

export const PhotoProvider: React.FC<PhotoProviderProps> = ({ children }) => {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const router = useRouter();

  const requestGalleryPermission = useCallback(
    async ({ askAgain }: { askAgain: boolean }): Promise<boolean> => {
      console.log("Requesting gallery permission...");
      const { status, canAskAgain, accessPrivileges } = await MediaLibrary.requestPermissionsAsync();
      console.log(`Permission status: ${status}, canAskAgain: ${canAskAgain}, accessPrivileges: ${accessPrivileges}`);
      if (status !== "granted" || accessPrivileges !== "all") {
        if (status === "denied" && canAskAgain && askAgain && accessPrivileges === "limited") {
          console.log("Permission denied but can ask again.");
          return false;
        } else {
          console.log("Navigating to SettingsInstructionsScreen due to insufficient permissions.");
          router.replace("/screens/SettingsInstructionsScreen");
        }
        return false;
      }
      console.log("Permission granted.");
      return true;
    },
    [router]
  );

  const handleContinue = useCallback(async () => {
    console.log("Handling continue...");
    const { status, canAskAgain, accessPrivileges } = await MediaLibrary.requestPermissionsAsync();
    console.log(`Permission status: ${status}, canAskAgain: ${canAskAgain}, accessPrivileges: ${accessPrivileges}`);
    if (status !== "granted" || accessPrivileges !== "all") {
      if (accessPrivileges === "limited" || !canAskAgain) {
        console.log("Navigating to screens/SettingsInstructionsScreen due to limited access or cannot ask again.");
        router.replace("/screens/SettingsInstructionsScreen");
      } else {
        console.log("Navigating to InitialScreen.");
        router.replace("/screens/InitialScreen");
      }
    } else {
      console.log("Navigating to InitialScreen.");
      router.replace("/screens/InitialScreen");
    }
  }, [router]);

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
        console.log(`Selected random photo URI: ${encodedUri}`);
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
      setPhotoUri,
      handleContinue,
    }),
    [photoUri, requestGalleryPermission, getRandomPhoto, pickGamePhoto, handleContinue]
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
