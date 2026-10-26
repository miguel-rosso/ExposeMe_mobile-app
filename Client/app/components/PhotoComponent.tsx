import { useEffect, useMemo, useRef, useState } from "react";
import { View, Platform, Animated, Image, ActivityIndicator } from "react-native";
import { BlurView } from "expo-blur";
import tw from "twrnc";
import { TouchableOpacity } from "react-native";
import { PhotoComponentProps } from "../models/interfaces";
import { getImageSource } from "../utils/image";
import { TEST_IDS } from "../utils/testIds";

// Android has no native blur view: the backdrop is the same photo, blurred by the image pipeline
const ANDROID_BACKDROP_BLUR_RADIUS = 50;

const PhotoComponent: React.FC<PhotoComponentProps> = ({ photoUrl, headers, onLongPress, onPressOut }) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  // Stable source object: a new one on every render could make the native image reload
  const source = useMemo(() => getImageSource(photoUrl, headers), [photoUrl, headers]);
  // The main photo has finished loading (or failed): ends the loading indicator and draws the Android backdrop
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  const photoSettled = settledUrl === photoUrl;
  const markSettled = () => setSettledUrl(photoUrl);

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
      {Platform.OS === "ios" && (
        <View style={tw`absolute w-full h-full `}>
          <Animated.Image source={source} style={[tw`w-full h-full`, { opacity: fadeAnim }]} resizeMode="cover" />
          <BlurView intensity={50} style={tw`absolute w-full h-full`} />
        </View>
      )}
      {/* One blurred image, without layout/measure round trips: the answering phase mounts this every round (EXP-225).
          Drawn once the main photo has loaded, from that decoded photo, instead of racing it for the download (EXP-131) */}
      {Platform.OS === "android" && (
        <View style={tw`absolute w-full h-full bg-black`}>
          {photoSettled && (
            <Image source={source} style={tw`w-full h-full`} resizeMode="cover" blurRadius={ANDROID_BACKDROP_BLUR_RADIUS} />
          )}
        </View>
      )}
      <View testID={TEST_IDS.photoView} style={tw`flex-1 justify-center items-center`}>
        <TouchableOpacity style={tw`w-full h-full`} activeOpacity={1} onLongPress={onLongPress} onPressOut={onPressOut}>
          <Animated.Image
            source={source}
            style={[tw`w-full h-full`, { opacity: fadeAnim }]}
            resizeMode="contain"
            onLoad={markSettled}
            onError={markSettled}
          />
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

export default PhotoComponent;
