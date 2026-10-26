import React from "react";
import { View, Text, TouchableOpacity, Image, Dimensions, Platform, StatusBar, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import tw from "twrnc";
import GalleryPermissionIMG from "@/assets/images/galleryPermissionIMG.jpg";
import PermissionRequestIOS from "@/assets/images/PermissionRequestIOS.jpg";
import FingerAnimation from "@/assets/animations/FingerAnimation.json";
import { useRouter } from "expo-router";
import { usePhotoContext } from "@/app/providers/PhotoContext";
import LottieView from "lottie-react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import LanguageToggle from "../components/LanguageToggle";
import { TEST_IDS } from "../utils/testIds";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

const InitialScreen: React.FC = () => {
  const { t } = useI18n();
  const router = useRouter();
  const { handleContinue } = usePhotoContext();
  // The bottom inset (Android gesture bar / iOS home indicator) pads the scroll content, not the frame,
  // so the hint under "Continue" can always be scrolled above it
  const insets = useSafeAreaInsets();

  // Maneja el evento de presionar el botón de continuar
  const handleContinuePress = async () => {
    await AsyncStorage.setItem("hasSeenInitialScreen", "true");
    await handleContinue();
    // Navega a la pantalla home
    router.replace("/");
  };

  // The app only asks for photos (audio/video are blocked in app.json): one system dialog per platform
  const permissionDialogImage = Platform.OS === "android" ? GalleryPermissionIMG : PermissionRequestIOS;

  // Calculate responsive dimensions for images
  const imageWidth = screenWidth * 0.7;
  const imageHeight = screenHeight * 0.3;

  return (
    <SafeAreaView testID={TEST_IDS.initialScreen} edges={["top", "left", "right"]} style={tw`flex-1 bg-gray-900`}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={[tw`flex-grow`, { paddingBottom: insets.bottom + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={tw`flex-1 px-4 pt-4 pb-6 max-w-[500px] w-full self-center`}>
          {/* Language (the onboarding carries the privacy notice: let users read it in their language) */}
          <View style={tw`items-end mb-2`}>
            <LanguageToggle />
          </View>

          {/* Header */}
          <View style={tw`items-center mb-5`}>
            <View style={tw`bg-amber-900/50 px-4 py-2 rounded-full mb-2`}>
              <Text testID={TEST_IDS.initialWarning} style={tw`text-xl font-bold text-amber-400`}>{t.warning}</Text>
            </View>
            <Text style={tw`text-sm text-gray-300 text-center`}>
              {t.permissionExplanation}
            </Text>
          </View>

          {/* Permission highlight box */}
          <View style={tw`bg-indigo-900/30 border border-indigo-700/50 rounded-xl p-4 mb-5`}>
            <Text style={tw`text-sm font-medium text-center text-indigo-300 mb-1`}>{t.requiredPermission}</Text>
            <Text style={tw`text-lg font-bold text-center text-indigo-200`}>{t.allowAll}</Text>
          </View>

          {/* Permission instructions */}
          <View style={tw`bg-gray-800 rounded-xl shadow-lg overflow-hidden mb-5 border border-gray-700`}>
            <View style={tw`bg-gray-700 py-2 px-4 border-b border-gray-600`}>
              <Text style={tw`text-base font-medium text-gray-100`}>
                {Platform.OS === "android" ? t.howToEnableAndroid : t.howToEnableIOS}
              </Text>
            </View>

            <View style={tw`p-3 items-center`}>
              <View style={tw`bg-gray-700 rounded-lg overflow-hidden shadow-lg mb-3 p-1 border border-gray-600`}>
                <Image source={permissionDialogImage} style={{ width: imageWidth, height: imageHeight }} resizeMode="contain" />
              </View>
              <Text style={tw`text-sm text-gray-300 text-center`}>
                {t.tapAllowAll}
              </Text>
            </View>
          </View>

          {/* Continue button and animation */}
          <View style={tw`items-center mt-6`}>
            <TouchableOpacity
              testID={TEST_IDS.initialContinueButton}
              style={tw`bg-blue-600 w-56 py-3 px-5 rounded-full shadow-lg flex-row justify-center items-center border border-blue-500`}
              onPress={handleContinuePress}
              activeOpacity={0.7}
            >
              <Text style={tw`text-white text-base font-medium mr-2`}>{t.continue_}</Text>
            </TouchableOpacity>
            <Text style={tw`text-gray-400 text-xs mt-2 mb-2`}>{t.tapToProceed}</Text>
            <LottieView source={FingerAnimation} autoPlay loop style={{ width: 48, height: 48 }} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

export default InitialScreen;
