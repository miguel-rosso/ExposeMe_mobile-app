import React, { useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  Linking,
  Dimensions,
  ScrollView,
  StyleSheet,
  Platform,
  StatusBar,
} from "react-native";
import tw from "twrnc";
import { useRouter } from "expo-router";
import CustomCarousel from "@/app/components/CustomCarousel/CustomCarousel";
import PermInstruction1 from "@/assets/images/PermInstructions1.jpg";
import PermInstruction2 from "@/assets/images/PermInstructions2.jpg";
import PermInstruction3 from "@/assets/images/PermInstructions3.jpg";
import IOSPermInstruction1 from "@/assets/images/IOSPermInstruction1.jpg";
import IOSPermInstruction2 from "@/assets/images/IOSPermInstruction2.jpg";
import IOSPermInstruction3 from "@/assets/images/IOSPermInstruction3.jpg";
import IOSPermInstruction4 from "@/assets/images/IOSPermInstruction4.jpg";
import IOSPermInstruction5 from "@/assets/images/IOSPermInstruction5.jpg";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

const SettingsInstructionsScreen: React.FC = () => {
  const { t } = useI18n();
  const router = useRouter();
  const carouselRef = useRef<any>(null);

  const androidImages = [
    { id: 1, source: PermInstruction1, title: t.step1, description: t.enablePermissions },
    { id: 2, source: PermInstruction2, title: t.step2, description: t.tapPhotosVideos },
    { id: 3, source: PermInstruction3, title: t.step3, description: t.allowAllTime },
  ];

  const iosImages = [
    { id: 1, source: IOSPermInstruction1, title: t.step1, description: t.enablePermissions },
    { id: 2, source: IOSPermInstruction2, title: t.step2, description: t.tapPhotosVideos },
    { id: 3, source: IOSPermInstruction3, title: t.step3, description: t.allowAllTime },
    { id: 4, source: IOSPermInstruction4, title: t.step4, description: t.goPrivacySettings },
    { id: 5, source: IOSPermInstruction5, title: t.step5, description: t.enableAllPermissions },
  ];

  const images = Platform.OS === "ios" ? iosImages : androidImages;

  const openSettings = () => {
    if (Platform.OS === "ios") {
      Linking.openURL("App-Prefs:root=Privacy");
    } else {
      Linking.openSettings();
    }
  };

  // Calculate fixed dimensions for images
  const imageContainerWidth = screenWidth * 0.75;
  const imageContainerHeight = screenHeight * 0.4;

  return (
    <SafeAreaView style={tw`flex-1 bg-gray-900`}>
      <StatusBar barStyle="light-content" backgroundColor="#111827" />
      <ScrollView contentContainerStyle={tw`flex-grow p-4`} showsVerticalScrollIndicator={false}>
        <View style={tw`flex-1 items-center max-w-[500px] w-full self-center`}>
          {/* Header */}
          <View style={tw`items-center mb-5`}>
            <View style={tw`bg-amber-900/50 px-5 py-3 rounded-full mb-3`}>
              <Text style={tw`text-2xl font-bold text-amber-400`}>{t.careful}</Text>
            </View>
            <Text style={tw`text-base text-gray-300 text-center`}>
              {t.fullAccessExplanation}
            </Text>
          </View>

          {/* Permission highlight box */}
          <View style={tw`bg-indigo-900/30 border border-indigo-700/50 rounded-xl p-4 mb-5 w-full`}>
            <Text style={tw`text-lg font-semibold text-center text-indigo-200 mb-1`}>{t.alwaysAllowAll}</Text>
          </View>

          {/* Carousel container */}
          <View style={tw`bg-gray-800 rounded-xl shadow-lg overflow-hidden mb-6 border border-gray-700 w-full`}>
            <View style={tw`bg-gray-700 py-2 px-4 border-b border-gray-600`}>
              <Text style={tw`text-base font-medium text-gray-100`}>
                {Platform.OS === "android" ? t.androidInstructions : t.iosInstructions}
              </Text>
            </View>
            <View style={tw`p-4`}>
              <CustomCarousel
                ref={carouselRef}
                data={images}
                renderItem={({ item }) => (
                  <View style={[styles.carouselItemContainer, { width: screenWidth * 0.8 }]}>
                    <View
                      style={[
                        tw`bg-white rounded-lg overflow-hidden shadow-lg mb-3 border border-gray-600`,
                        { width: imageContainerWidth, height: imageContainerHeight },
                      ]}
                    >
                      <Image source={item.source} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
                    </View>
                    <Text style={tw`text-base font-bold text-gray-200 mb-1`}>{item.title}</Text>
                    <Text style={tw`text-sm text-gray-400 text-center`}>{item.description}</Text>
                  </View>
                )}
                disablePagination={false}
                widthBoundaryForPagination={screenWidth * 0.8}
                decelerationRate="fast"
                snapToInterval={screenWidth * 0.8}
              />
            </View>
          </View>

          {/* Bottom buttons */}
          <View style={tw`flex-row justify-between w-full mt-4 mb-2`}>
            <TouchableOpacity
              style={tw`bg-gray-700 p-4 rounded-xl flex-1 mr-3 border border-gray-600`}
              onPress={() => router.replace("/")}
              activeOpacity={0.7}
            >
              <Text style={tw`text-gray-200 text-base font-medium text-center`}>{t.back}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={tw`bg-blue-600 p-4 flex-1 ml-3 rounded-xl border border-blue-500 shadow-lg`}
              onPress={openSettings}
              activeOpacity={0.7}
            >
              <Text style={tw`text-white text-base font-medium text-center`}>{t.openSettings}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  carouselItemContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
  },
  image: {
    width: "100%",
    height: "100%",
    borderRadius: 8,
  },
});

export default SettingsInstructionsScreen;
