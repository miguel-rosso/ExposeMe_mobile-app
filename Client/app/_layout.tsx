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
import { I18nProvider } from "./i18n";
import { hideDevToolsButton } from "./utils/devToolsButton";

SplashScreen.preventAutoHideAsync();
hideDevToolsButton();

// Home always sits at the bottom of the stack: a link that cold-starts the app (an invite to screens/WaitingRoom)
// opens on top of it, so Back and dismissTo("/") reach home instead of closing the app
export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  const [loaded] = useFonts({
    IconFont: require("@/assets/fonts/b.otf"),
  });

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  // Retry after the first render: the dev menu may not have been ready at module load
  useEffect(() => {
    hideDevToolsButton();
  }, []);

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
    <I18nProvider>
    <PhotoProvider>
      <GameProvider>
        <BackgroundProvider>
          <StatusBar hidden={true} />
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false, animation: "fade" }} />
            <Stack.Screen name="screens/OwnPhotos" options={{ headerShown: false, animation: "fade" }} />
            <Stack.Screen name="screens/WaitingRoom" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="screens/InitialScreen" options={{ headerShown: false }} />
            <Stack.Screen name="screens/SettingsInstructionsScreen" options={{ headerShown: false }} />
            <Stack.Screen name="screens/GameScreen" options={{ headerShown: false, gestureEnabled: false }} />
          </Stack>
        </BackgroundProvider>
      </GameProvider>
    </PhotoProvider>
    </I18nProvider>
  );
}
