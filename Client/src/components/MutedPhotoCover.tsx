import React, { memo } from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import { BlurView } from "expo-blur";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";

// iOS blurs the photo under the cover, then darkens it; Android has no native blur over a sibling view (expo-blur
// needs the photo inside a BlurTargetView), so there the cover is all but opaque: the photo never shows through
const IOS_BLUR_INTENSITY = 100;
const COVER_BACKING = Platform.OS === "ios" ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.95)";

interface MutedPhotoCoverProps {
  /** The round photo is a muted player's and was not revealed (useMutedPhotoReveal) */
  covered: boolean;
  /** Reveals it for this round; without it no Show is drawn (the scoreboard over the cover has its own) */
  onShow?: () => void;
}

/**
 * Covers the round photo of a muted player (EXP-422) with a notice and a Show button. Drawn right over the photo, under
 * the game's overlay (answers, scoreboard), and kept while the photo is held.
 */
const MutedPhotoCover: React.FC<MutedPhotoCoverProps> = ({ covered, onShow }) => {
  const { t } = useI18n();
  if (!covered) return null;

  return (
    // Kept out of view flattening (layout-only styles), so the device flows find it (qa/maestro/mute-player.yaml)
    <View testID={TEST_IDS.mutedPhotoCover} style={tw`absolute inset-0 justify-center items-center`} collapsable={false}>
      {Platform.OS === "ios" && <BlurView intensity={IOS_BLUR_INTENSITY} tint="dark" style={tw`absolute inset-0`} />}
      <View style={[tw`absolute inset-0`, { backgroundColor: COVER_BACKING }]} />
      <Text style={tw`text-white text-lg font-bold text-center px-6 mb-4`}>{t.mutedPlayerPhoto}</Text>
      {onShow && <ShowMutedPhotoButton testID={TEST_IDS.mutedPhotoShowButton} onPress={onShow} />}
    </View>
  );
};

interface ShowMutedPhotoButtonProps {
  testID: string;
  onPress: () => void;
}

/** "Show": reveals a muted player's round photo for this round (on the cover, and on the scoreboard over it) */
export const ShowMutedPhotoButton: React.FC<ShowMutedPhotoButtonProps> = ({ testID, onPress }) => {
  const { t } = useI18n();
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={t.mutedPlayerPhoto}
      onPress={onPress}
      style={tw`px-6 py-2 rounded-full bg-white/20 border border-white/40`}
    >
      <Text style={tw`text-white text-base font-semibold`}>{t.showMutedPhoto}</Text>
    </TouchableOpacity>
  );
};

// Memoised: the game screen re-renders on every phase and pick, the cover only with the photo or a mute
export default memo(MutedPhotoCover);
