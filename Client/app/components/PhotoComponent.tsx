import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View, Platform, Animated, Image, ActivityIndicator, type ImageSourcePropType } from "react-native";
import { BlurView } from "expo-blur";
import tw from "twrnc";
import { TouchableOpacity } from "react-native";
import { PhotoComponentProps } from "../models/interfaces";
import { downloadImageToMemory, getImageSource, isRemoteUri } from "../utils/image";
import { TEST_IDS } from "../utils/testIds";

// Android has no native blur view: the backdrop is the same photo, blurred by the image pipeline
const ANDROID_BACKDROP_BLUR_RADIUS = 50;

interface DownloadedSource {
  photoUrl: string;
  source: ImageSourcePropType;
  /** The source is the in-memory copy (false: the photo URL, after the copy failed) */
  inMemory: boolean;
}

interface PhotoSource {
  /** What both views draw; null while the in-memory copy downloads */
  source: ImageSourcePropType | null;
  /**
   * For a main photo that failed to draw: if it was drawing the in-memory copy, switches both views to the photo URL
   * and returns true (the <Image> retries the download). False when the photo URL itself failed: a real error.
   */
  retryFromServer: () => boolean;
}

/**
 * The image source both views of the photo (main photo and blurred backdrop) draw. Stable per photo: a new object on
 * every render could make the native image reload. On iOS a server photo is downloaded once into memory and both
 * views read that copy: iOS would download it once per view (EXP-394). If the copy can't be downloaded or drawn, the
 * views fall back to the photo URL, so the <Image> retries it and reports the error as before.
 */
const usePhotoSource = (photoUrl: string, headers?: Record<string, string>): PhotoSource => {
  const remoteSource = useMemo(() => getImageSource(photoUrl, headers), [photoUrl, headers]);
  const downloadsOnce = Platform.OS === "ios" && isRemoteUri(photoUrl);
  const [downloaded, setDownloaded] = useState<DownloadedSource | null>(null);

  useEffect(() => {
    if (!downloadsOnce) return;
    let current = true;
    const download = downloadImageToMemory(photoUrl, headers);
    download.uri.then(
      (uri) => current && setDownloaded({ photoUrl, source: { uri }, inMemory: true }),
      () => current && setDownloaded({ photoUrl, source: remoteSource, inMemory: false })
    );
    return () => {
      current = false;
      download.release();
    };
  }, [downloadsOnce, photoUrl, headers, remoteSource]);

  if (!downloadsOnce) return { source: remoteSource, retryFromServer: () => false };
  // A copy downloaded for the previous photo is never drawn for this one
  const forThisPhoto = downloaded?.photoUrl === photoUrl ? downloaded : null;
  const retryFromServer = () => {
    if (!forThisPhoto?.inMemory) return false;
    setDownloaded({ photoUrl, source: remoteSource, inMemory: false });
    return true;
  };
  return { source: forThisPhoto?.source ?? null, retryFromServer };
};

const PhotoComponent: React.FC<PhotoComponentProps> = ({ photoUrl, headers, onLongPress, onPressOut }) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const { source, retryFromServer } = usePhotoSource(photoUrl, headers);
  // The main photo has finished loading (or failed): ends the loading indicator and draws the backdrop
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  const photoSettled = settledUrl === photoUrl;
  const markSettled = () => setSettledUrl(photoUrl);
  const handlePhotoError = () => {
    if (!retryFromServer()) markSettled();
  };

  // Each photo fades in. The value starts at 0 on mount and a new photo resets it in the previous one's cleanup: a
  // reset on mount would cost the just-mounted image an extra render (EXP-225)
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
    return () => fadeAnim.setValue(0);
  }, [photoUrl]);

  return (
    <>
      {/* Both backdrops are drawn once the main photo has loaded, from the same source, so they never race it for the
          download (EXP-131, EXP-394) */}
      {Platform.OS === "ios" && (
        <View style={tw`absolute w-full h-full `}>
          {photoSettled && source && (
            <Animated.Image source={source} style={[tw`w-full h-full`, { opacity: fadeAnim }]} resizeMode="cover" />
          )}
          <BlurView intensity={50} style={tw`absolute w-full h-full`} />
        </View>
      )}
      {/* One blurred image, without layout/measure round trips: the answering phase mounts this every round (EXP-225) */}
      {Platform.OS === "android" && (
        <View style={tw`absolute w-full h-full bg-black`}>
          {photoSettled && source && (
            <Image source={source} style={tw`w-full h-full`} resizeMode="cover" blurRadius={ANDROID_BACKDROP_BLUR_RADIUS} />
          )}
        </View>
      )}
      <View testID={TEST_IDS.photoView} style={tw`flex-1 justify-center items-center`}>
        <TouchableOpacity style={tw`w-full h-full`} activeOpacity={1} onLongPress={onLongPress} onPressOut={onPressOut}>
          {source && (
            <Animated.Image
              source={source}
              style={[tw`w-full h-full`, { opacity: fadeAnim }]}
              resizeMode="contain"
              onLoad={markSettled}
              onError={handlePhotoError}
            />
          )}
        </TouchableOpacity>
        {/* While the photo downloads: never blocks the timer or the answers drawn over it (EXP-119) */}
        {!photoSettled && (
          <View style={[tw`absolute inset-0 justify-center items-center`, { pointerEvents: "none" }]}>
            <ActivityIndicator testID={TEST_IDS.photoLoading} size="small" color="rgba(255,255,255,0.7)" />
          </View>
        )}
      </View>
    </>
  );
};

// Memoised: the game screen re-renders on every phase and pick, the photo only changes with the round (EXP-265)
export default memo(PhotoComponent);
