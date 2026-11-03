import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "@/src/utils/testIds";

interface ServerUnreachableOverlayProps {
  /** Try again: the socket keeps retrying and the wait starts over */
  onRetry: () => void;
  /** Back to home, keeping the player's seat in the room (unlike the screen's Exit) */
  onBack: () => void;
}

/** Takes the loading overlay's place when the server can't be reached (EXP-417): says why, and offers a way out. */
const ServerUnreachableOverlay = ({ onRetry, onBack }: ServerUnreachableOverlayProps) => {
  const { t } = useI18n();
  const button = (testID: string, label: string, onPress: () => void, color: string) => (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={tw`${color} px-4 py-3 rounded-xl mt-3 w-full`}
    >
      <Text style={tw`text-white text-base font-bold text-center`}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View
      testID={TEST_IDS.serverUnreachable}
      style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}
    >
      <View style={tw`px-8 py-6 rounded-xl bg-gray-800 items-center w-4/5 max-w-[500px]`}>
        <Ionicons name="cloud-offline-outline" size={40} color="white" />
        <Text accessibilityRole="alert" style={tw`text-white mt-4 mb-2 text-lg font-bold text-center`}>
          {t.serverUnreachable}
        </Text>
        {button(TEST_IDS.serverUnreachableRetry, t.tryAgain, onRetry, "bg-blue-600")}
        {button(TEST_IDS.serverUnreachableBack, t.back, onBack, "bg-gray-700")}
      </View>
    </View>
  );
};

export default ServerUnreachableOverlay;
