import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as ScreenOrientation from "expo-screen-orientation";
import { DeviceType, getDeviceTypeAsync } from "expo-device";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import "react-native-reanimated";
import { PhotoProvider } from "@/app/providers/PhotoContext";
import { GameProvider } from "./providers/GameContext";
import { BackgroundProvider } from "./providers/BackgroundContext";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded] = useFonts({
    IconFont: require("@/assets/fonts/b.otf"),
  });

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  useEffect(() => {
    (async () => {
      const deviceType = await getDeviceTypeAsync();
      if (deviceType === DeviceType.PHONE) {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      }
    })();
  }, []);

  if (!loaded) {
    return null;
  }

  return (
    <PhotoProvider>
      <GameProvider>
        <BackgroundProvider>
          <StatusBar hidden={true} translucent={true} />
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false, animation: "fade" }} />
            <Stack.Screen name="screens/OwnPhotos" options={{ headerShown: false, animation: "fade" }} />
            <Stack.Screen name="screens/WaitingRoom" options={{ headerShown: false }} />
            <Stack.Screen name="screens/InitialScreen" options={{ headerShown: false }} />
            <Stack.Screen name="screens/SettingsInstructionsScreen" options={{ headerShown: false }} />
            <Stack.Screen name="screens/GameScreen" options={{ headerShown: false }} />
          </Stack>
        </BackgroundProvider>
      </GameProvider>
    </PhotoProvider>
  );
}
