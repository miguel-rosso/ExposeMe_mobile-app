import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import tw from "twrnc";
import { Ionicons } from "@react-native-vector-icons/ionicons/static";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";
import { BRAND_RED } from "../theme/brand";
import { useLimitedGalleryAccess } from "../hooks/useLimitedGalleryAccess";

const ICON_SIZE = 14;
const ADD_MORE_HIT_SLOP = { top: 10, bottom: 10, left: 8, right: 8 };

/**
 * Home notice while only part of the gallery is shared; disappears once access is full (or gone). Always one line, so
 * it stays clear of the logo below it on small phones.
 */
const LimitedAccessBanner = () => {
  const { t } = useI18n();
  const { limited, addMorePhotos } = useLimitedGalleryAccess();
  if (!limited) return null;

  return (
    <View
      testID={TEST_IDS.homeLimitedBanner}
      style={tw`flex-row items-center bg-black/50 border border-white/15 rounded-2xl pl-3 pr-1 py-1`}
    >
      <Ionicons name="images-outline" size={ICON_SIZE} color="white" />
      <Text style={tw`text-white text-xs ml-1.5 flex-shrink`} numberOfLines={1}>
        {t.limitedAccessBanner}
      </Text>
      <TouchableOpacity
        testID={TEST_IDS.homeLimitedAddMore}
        accessibilityRole="button"
        hitSlop={ADD_MORE_HIT_SLOP}
        onPress={addMorePhotos}
        style={[tw`ml-2 px-2.5 py-0.5 rounded-xl`, { backgroundColor: BRAND_RED }]}
      >
        <Text style={tw`text-white text-xs font-bold`} numberOfLines={1}>
          {t.addMorePhotos}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

export default LimitedAccessBanner;
