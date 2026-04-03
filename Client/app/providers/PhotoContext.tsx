import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import * as MediaLibrary from "expo-media-library";
import { useRouter } from "expo-router";
import { PhotoContextProps, PhotoProviderProps } from "@/app/models/interfaces";
import { Platform } from "react-native";

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

  const getRandomPhoto = useCallback(async (): Promise<string | null> => {
    console.log("Getting random photo...");
    const hasPermission = await requestGalleryPermission({ askAgain: true });
    if (!hasPermission) {
      console.log("No permission to access gallery.");
      return null;
    }

    const { totalCount } = await MediaLibrary.getAssetsAsync({ mediaType: "photo" });
    if (totalCount === 0) {
      console.log("No photos on device.");
      return null;
    }

    // Retry up to 3 times if the random index lands on an empty slot
    for (let i = 0; i < 3; i++) {
      const randomIndex = Math.floor(Math.random() * totalCount);
      console.log(`Selected photo index: ${randomIndex}`);

      let uri: string | null = null;

      if (Platform.OS === "ios") {
        const { assets } = await MediaLibrary.getAssetsAsync({
          mediaType: "photo",
          first: 1,
          after:
            randomIndex > 0
              ? (await MediaLibrary.getAssetsAsync({ mediaType: "photo", first: randomIndex })).assets[randomIndex - 1]?.id
              : undefined,
        });
        if (assets.length > 0) {
          const assetInfo = await MediaLibrary.getAssetInfoAsync(assets[0].id);
          uri = assetInfo.localUri || assetInfo.uri;
        }
      } else {
        const { assets } = await MediaLibrary.getAssetsAsync({
          mediaType: "photo",
          first: 1,
          after: randomIndex.toString(),
        });
        if (assets.length > 0) {
          uri = assets[0].uri;
        }
      }

      if (uri) {
        const encodedUri = encodeURI(uri);
        console.log(`Selected random photo URI: ${encodedUri}`);
        setPhotoUri(encodedUri);
        return encodedUri;
      }
    }

    console.log("Failed to select a photo after retries.");
    return null;
  }, [requestGalleryPermission]);

  const contextValue = useMemo(
    () => ({
      photoUri,
      requestGalleryPermission,
      getRandomPhoto,
      setPhotoUri,
      handleContinue,
    }),
    [photoUri, requestGalleryPermission, getRandomPhoto, handleContinue]
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
