import React from "react";
import { View, Text, TouchableOpacity, Image, StatusBar, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import tw from "twrnc";
import { useRouter } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import backdropImage from "@/assets/images/bg1.jpg";
import { usePhotoContext } from "@/src/providers/PhotoContext";
import { useI18n } from "../../src/i18n";
import LanguageToggle from "../../src/components/LanguageToggle";
import PhotoFanHero, { HERO_HEIGHT } from "../../src/components/PhotoFanHero";
import { useReduceMotionSetting } from "../../src/hooks/useReduceMotion";
import { TEST_IDS } from "../../src/utils/testIds";
import { BRAND_DISPLAY_FONT, BRAND_GRADIENT, brandTitleShadow } from "../../src/theme/brand";

// ── Look ──
const BACKDROP_BLUR_RADIUS = 12;
const BACKDROP_FADE = ["transparent", "#000"] as const;
const POINT_ICON_BG = "rgba(233, 4, 46, 0.2)";
const POINT_ICON_COLOR = "#ff4d6a";
const POINT_ICON_SIZE = 18;

// ── Layout ──
const TITLE_FONT_SIZE = 36;
const TITLE_LINE_HEIGHT = 42;
const TITLE_SHADOW = brandTitleShadow(TITLE_FONT_SIZE);
/** The accents of «GALERÍA» rise above the font's ascender: room so they are not clipped */
const TITLE_ACCENT_ROOM = 6;
/** The language toggle floats at top-12 (48 px) and is about 40 px tall: the content starts below it */
const LANGUAGE_TOGGLE_CLEARANCE = 96;
/** Space between the fixed footer and the bottom inset (Android gesture bar / iOS home indicator) */
const FOOTER_BOTTOM_GAP = 16;

type Translations = ReturnType<typeof useI18n>["t"];

/** What happens with the photos, one row each */
const REASSURANCE_POINTS: { icon: React.ComponentProps<typeof Ionicons>["name"]; text: (t: Translations) => string }[] = [
  { icon: "shuffle", text: (t) => t.initialPointRandom },
  { icon: "people", text: (t) => t.initialPointRoom },
  { icon: "time-outline", text: (t) => t.initialPointDeleted },
];

const InitialScreen: React.FC = () => {
  const { t } = useI18n();
  const router = useRouter();
  const { handleContinue } = usePhotoContext();
  // Undefined until the system answers: the hero waits for it so it never starts animating and then jumps
  const reduceMotion = useReduceMotionSetting();
  // "Continue" lives in a fixed footer outside the ScrollView, padded by the bottom inset: on short gesture-nav
  // phones a button at the end of the scroll content could be left as a sliver above the gesture bar (EXP-196)
  const insets = useSafeAreaInsets();

  // Asks for photo access (whatever the answer, the home gate handles it) and goes home
  const handleContinuePress = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await AsyncStorage.setItem("hasSeenInitialScreen", "true");
    await handleContinue();
    router.replace("/");
  };

  return (
    <View style={tw`flex-1 bg-black`}>
      <StatusBar barStyle="light-content" />

      {/* Backdrop: a blurred photo, darkened and fading to black at the bottom */}
      <Image source={backdropImage} blurRadius={BACKDROP_BLUR_RADIUS} resizeMode="cover" style={tw`absolute inset-0 w-full h-full`} />
      <View style={tw`absolute inset-0 bg-black/70`} />
      <LinearGradient colors={BACKDROP_FADE} style={tw`absolute inset-x-0 bottom-0 h-1/2`} />

      <SafeAreaView testID={TEST_IDS.initialScreen} edges={["left", "right"]} style={tw`flex-1`}>
        <ScrollView
          style={tw`flex-1`}
          contentContainerStyle={[
            tw`flex-grow justify-center px-6 pb-4`,
            { paddingTop: Math.max(insets.top, LANGUAGE_TOGGLE_CLEARANCE) },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={tw`w-full max-w-[500px] self-center items-center`}>
            {reduceMotion === undefined ? (
              <View style={{ height: HERO_HEIGHT }} />
            ) : (
              <PhotoFanHero animate={!reduceMotion} />
            )}

            {/* Full width, not shrink-wrapped by the centred column: Android measured the wrapped box a hair narrower
                than the line draws, so «YOUR GALLERY» wrapped and «IS THE GAME» fell outside the box (EXP-275) */}
            <Text
              testID={TEST_IDS.initialTitle}
              accessibilityRole="header"
              style={[
                tw`w-full text-white text-center mt-6`,
                {
                  fontFamily: BRAND_DISPLAY_FONT,
                  fontSize: TITLE_FONT_SIZE,
                  lineHeight: TITLE_LINE_HEIGHT,
                  paddingTop: TITLE_ACCENT_ROOM,
                },
                TITLE_SHADOW,
              ]}
            >
              {t.initialTitle}
            </Text>
            <Text style={tw`text-base leading-6 text-white/70 text-center mt-4`}>{t.initialSubtitle}</Text>

            {/* Reassurance */}
            <View style={tw`w-full bg-white/10 border border-white/10 rounded-2xl p-4 mt-8`}>
              {REASSURANCE_POINTS.map((point, i) => (
                <View key={point.icon} style={tw`flex-row items-center ${i > 0 ? "mt-3" : ""}`}>
                  <View style={[tw`w-8 h-8 rounded-full items-center justify-center`, { backgroundColor: POINT_ICON_BG }]}>
                    <Ionicons name={point.icon} size={POINT_ICON_SIZE} color={POINT_ICON_COLOR} />
                  </View>
                  <Text style={tw`flex-1 ml-3 text-[15px] text-white/90`}>{point.text(t)}</Text>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>

        {/* The only action, fixed above the bottom inset: ask for photo access */}
        <View style={[tw`px-6 pt-4`, { paddingBottom: insets.bottom + FOOTER_BOTTOM_GAP }]}>
          <View style={tw`w-full max-w-[500px] self-center`}>
            <LinearGradient
              colors={BRAND_GRADIENT}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={tw`w-full h-15 rounded-2xl`}
            >
              <TouchableOpacity
                testID={TEST_IDS.initialContinueButton}
                accessibilityRole="button"
                style={tw`flex-1 items-center justify-center`}
                onPress={handleContinuePress}
                activeOpacity={0.8}
              >
                <Text style={tw`text-white text-lg font-bold`}>{t.continue_}</Text>
              </TouchableOpacity>
            </LinearGradient>
            <Text style={tw`text-[13px] text-white/50 text-center mt-4`}>{t.initialFootnote}</Text>
          </View>
        </View>
      </SafeAreaView>

      <View style={tw`absolute top-12 left-4 z-20`}>
        <LanguageToggle />
      </View>
    </View>
  );
};

export default InitialScreen;
