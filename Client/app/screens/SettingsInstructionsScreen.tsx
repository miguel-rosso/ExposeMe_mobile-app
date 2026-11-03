import React, { useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  Linking,
  Alert,
  Dimensions,
  ScrollView,
  StyleSheet,
  Platform,
  StatusBar,
} from "react-native";
import tw from "twrnc";
import { useRouter } from "expo-router";
import CustomCarousel from "@/src/components/CustomCarousel/CustomCarousel";
import PermInstruction1 from "@/assets/images/PermInstructions1.jpg";
import PermInstruction2 from "@/assets/images/PermInstructions2.jpg";
import PermInstruction3 from "@/assets/images/PermInstructions3.jpg";
import IOSPermInstruction1 from "@/assets/images/IOSPermInstruction1.jpg";
import IOSPermInstruction2 from "@/assets/images/IOSPermInstruction2.jpg";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../../src/i18n";
import { TEST_IDS, settingsStepId } from "../../src/utils/testIds";
import { HOME_PATH } from "../../src/utils/homeRoute";
import { contactEmail, contactMailtoUrl, openExternalLink, privacyPolicyUrl } from "../../src/utils/legalLinks";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
// Gap kept between the buttons and the bottom inset (same as the p-4 padding on the other edges)
const FOOTER_BOTTOM_GAP = 16;

const SettingsInstructionsScreen: React.FC = () => {
  const { t, lang } = useI18n();
  const router = useRouter();
  const carouselRef = useRef<any>(null);
  // The buttons live in a fixed footer outside the ScrollView, padded by the bottom inset (Android gesture bar /
  // iOS home indicator), so they are always fully on screen whatever the content height
  const insets = useSafeAreaInsets();

  const androidImages = [
    { id: 1, source: PermInstruction1, title: t.step1, description: t.androidTapPermissions },
    { id: 2, source: PermInstruction2, title: t.step2, description: t.tapPhotosVideos },
    { id: 3, source: PermInstruction3, title: t.step3, description: t.allowAllTime },
  ];

  // Linking.openSettings() usually lands on this app's own Settings page, so the iOS steps start at its "Photos" row;
  // step 1 also covers the Settings root (where the iOS simulator can land) by naming the path to the app's page
  const iosImages = [
    { id: 1, source: IOSPermInstruction1, title: t.step1, description: t.iosTapPhotosChooseAccess },
    { id: 2, source: IOSPermInstruction2, title: t.step2, description: t.iosConfirmFullAccess },
  ];

  const images = Platform.OS === "ios" ? iosImages : androidImages;

  // ── Privacy policy and contact (EXP-426) ──
  // No contact row when the build has no (valid) contact address
  const email = contactEmail();
  const openPrivacyPolicy = () => openExternalLink(privacyPolicyUrl(lang));
  // Without a mail app the address is shown instead, so it can still be written to
  const openContact = async (address: string) => {
    if (!(await openExternalLink(contactMailtoUrl(address)))) Alert.alert(t.contactUs, address);
  };

  // Calculate fixed dimensions for images
  const imageContainerWidth = screenWidth * 0.75;
  const imageContainerHeight = screenHeight * 0.4;

  return (
    <SafeAreaView testID={TEST_IDS.settingsInstructionsScreen} edges={["top", "left", "right"]} style={tw`flex-1 bg-gray-900`}>
      <StatusBar barStyle="light-content" />
      <ScrollView style={tw`flex-1`} contentContainerStyle={tw`flex-grow p-4`} showsVerticalScrollIndicator={false}>
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
                    <Text testID={settingsStepId(item.id)} style={tw`text-sm text-gray-400 text-center`}>
                      {item.description}
                    </Text>
                  </View>
                )}
                disablePagination={false}
                widthBoundaryForPagination={screenWidth * 0.8}
                decelerationRate="fast"
                snapToInterval={screenWidth * 0.8}
              />
            </View>
          </View>

          {/* Privacy policy and contact */}
          <View style={tw`bg-gray-800 rounded-xl border border-gray-700 w-full mb-2`}>
            <TouchableOpacity
              testID={TEST_IDS.settingsPrivacyLink}
              accessibilityRole="link"
              accessibilityLabel={t.privacyPolicy}
              style={tw`px-4 py-3`}
              onPress={openPrivacyPolicy}
              activeOpacity={0.7}
            >
              <Text style={tw`text-base text-gray-100`}>{t.privacyPolicy}</Text>
            </TouchableOpacity>
            {email && (
              <TouchableOpacity
                testID={TEST_IDS.settingsContactLink}
                accessibilityRole="link"
                accessibilityLabel={`${t.contactUs}: ${email}`}
                style={tw`px-4 py-3 border-t border-gray-700`}
                onPress={() => openContact(email)}
                activeOpacity={0.7}
              >
                <Text style={tw`text-base text-gray-100`}>{t.contactUs}</Text>
                <Text style={tw`text-sm text-gray-400`}>{email}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Bottom buttons: fixed footer above the bottom inset */}
      <View style={[tw`px-4 pt-3`, { paddingBottom: insets.bottom + FOOTER_BOTTOM_GAP }]}>
        <View style={tw`flex-row justify-between w-full max-w-[500px] self-center`}>
          <TouchableOpacity
            style={tw`bg-gray-700 p-4 rounded-xl flex-1 mr-3 border border-gray-600`}
            testID={TEST_IDS.settingsInstructionsBack}
            // Pops back to the home that opened it (replace would stack a second home over it: EXP-339)
            onPress={() => router.dismissTo(HOME_PATH)}
            activeOpacity={0.7}
          >
            <Text style={tw`text-gray-200 text-base font-medium text-center`}>{t.back}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={tw`bg-blue-600 p-4 flex-1 ml-3 rounded-xl border border-blue-500 shadow-lg`}
            testID={TEST_IDS.settingsInstructionsOpenSettings}
            onPress={() => Linking.openSettings()}
            activeOpacity={0.7}
          >
            <Text style={tw`text-white text-base font-medium text-center`}>{t.openSettings}</Text>
          </TouchableOpacity>
        </View>
      </View>
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
