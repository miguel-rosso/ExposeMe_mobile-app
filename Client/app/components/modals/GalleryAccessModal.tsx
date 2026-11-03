import React from "react";
import { Linking, Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useI18n } from "../../i18n";
import { TEST_IDS } from "@/app/utils/testIds";
import type { GalleryAccess } from "@/app/utils/galleryAccess";

interface GalleryAccessModalProps {
  /** What is missing to play, or null (hidden) */
  access: GalleryAccess | null;
  /** Show the system permission prompt again (only offered while it still can be shown) */
  onAllow: () => void;
  /** Limited access: open the system picker to share more photos */
  onSelectPhotos: () => void;
  /** Check again (e.g. after adding photos) */
  onRetry: () => void;
  /** Back button: close the notice (home), leave the room (lobby) or ask to leave the game (game, EXP-377) */
  onBack?: () => void;
  /** The back button's label ("Back" unless the screen says what it does) */
  backLabel?: string;
  /** Lobby / game: stays until access is back (re-checked on foreground) and says so */
  blocking?: boolean;
  /** Home: step-by-step guide to enable the permission in the system settings */
  onShowHelp?: () => void;
}

/** Explains why the player can't play without photo access / photos and how to fix it. Never navigates by itself. */
const GalleryAccessModal: React.FC<GalleryAccessModalProps> = ({
  access, onAllow, onSelectPhotos, onRetry, onBack, backLabel, blocking, onShowHelp,
}) => {
  const { t } = useI18n();
  if (!access || access.status === "ok") return null;

  const denied = access.status === "denied";
  // The gallery could not be read: nothing to fix in the system, only Try again
  const unavailable = access.status === "unavailable";
  const limitedNoPhotos = access.status === "no-photos" && access.limited;
  const title = denied ? t.galleryAccessTitle : unavailable ? t.galleryUnavailableTitle : t.galleryNoPhotosTitle;
  const message = denied
    ? t.galleryAccessDenied
    : unavailable
      ? t.galleryUnavailable
      : access.limited ? t.galleryNoPhotosLimited : t.galleryNoPhotos;
  const button = (testID: string, label: string, onPress: () => void, color = "bg-blue-600") => (
    <TouchableOpacity testID={testID} onPress={onPress} style={tw`${color} px-4 py-3 rounded-xl mb-3 w-full`}>
      <Text style={tw`text-white text-base font-bold text-center`}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View
      testID={TEST_IDS.galleryAccessModal}
      style={tw`absolute top-0 left-0 right-0 bottom-0 z-100 justify-center items-center bg-black bg-opacity-80`}
    >
      <View style={tw`rounded-lg p-6 bg-gray-800 w-4/5 max-w-[500px] items-center`}>
        <Text style={tw`text-2xl text-white font-bold text-center mb-3`}>{title}</Text>
        <Text testID={TEST_IDS.galleryAccessMessage} style={tw`text-base text-white text-center mb-5`}>
          {message}
        </Text>
        {denied && access.canAskAgain && button(TEST_IDS.galleryAllowButton, t.allowAccess, onAllow)}
        {limitedNoPhotos && button(TEST_IDS.gallerySelectPhotosButton, t.selectPhotos, onSelectPhotos)}
        {(denied || limitedNoPhotos) &&
          button(TEST_IDS.gallerySettingsButton, t.openSettings, () => Linking.openSettings(), denied && access.canAskAgain ? "bg-gray-600" : "bg-blue-600")}
        {!denied && button(TEST_IDS.galleryRetryButton, t.tryAgain, onRetry, limitedNoPhotos ? "bg-gray-600" : "bg-blue-600")}
        {denied && !access.canAskAgain && onShowHelp && button(TEST_IDS.galleryHelpButton, t.howToEnable, onShowHelp, "bg-gray-600")}
        {onBack && button(TEST_IDS.galleryBackButton, backLabel ?? t.back, onBack, "bg-gray-700")}
        {blocking && !unavailable && <Text style={tw`text-sm text-gray-300 text-center`}>{t.galleryBlockedNote}</Text>}
      </View>
    </View>
  );
};

export default GalleryAccessModal;
