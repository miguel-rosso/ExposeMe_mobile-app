import React from "react";
import { Text, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import tw from "twrnc";
import { useI18n } from "@/app/i18n";
import { TEST_IDS } from "@/app/utils/testIds";
import { LEAVE_BUTTON } from "@/app/utils/gameRows";

interface LeaveGameButtonProps {
  /** Asks whether to leave (LeaveGameConfirm); never leaves by itself */
  onPress: () => void;
}

/** The game's Exit (EXP-377): a small pill in the bottom-left corner, under the emoji row (see gameRows) */
const LeaveGameButton: React.FC<LeaveGameButtonProps> = ({ onPress }) => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <TouchableOpacity
      testID={TEST_IDS.leaveGameButton}
      accessibilityRole="button"
      accessibilityLabel={t.leaveGame}
      onPress={onPress}
      style={[
        tw`absolute z-80 justify-center px-4 rounded-full bg-gray-800 bg-opacity-80`,
        { bottom: insets.bottom + LEAVE_BUTTON.bottom, left: insets.left + LEAVE_BUTTON.side, height: LEAVE_BUTTON.height },
      ]}
    >
      <Text style={tw`text-white text-sm font-semibold`}>{t.exit}</Text>
    </TouchableOpacity>
  );
};

export default LeaveGameButton;
