import React from "react";
import { View } from "react-native";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { TEST_IDS } from "@/src/utils/testIds";
import AlertModal from "./AlertModal";

interface LeaveGameConfirmProps {
  visible: boolean;
  /** Leave the game for good */
  onConfirm: () => void;
  /** Stay in the game */
  onCancel: () => void;
}

/**
 * "Leave the game? You won't be able to rejoin" (DEC-050 A), asked by the game's Exit, the pause modal's and Android
 * back. Its own layer above every overlay of the game screen (the pause modal, the gallery notice, the reconnecting
 * banner): the alert itself only sits above the screen's content.
 */
const LeaveGameConfirm: React.FC<LeaveGameConfirmProps> = ({ visible, onConfirm, onCancel }) => {
  const { t } = useI18n();
  if (!visible) return null;

  return (
    <View testID={TEST_IDS.leaveGameConfirm} accessibilityViewIsModal style={tw`absolute inset-0 z-110`}>
      <AlertModal
        visible
        title={t.leaveGameConfirmTitle}
        message={t.leaveGameConfirmMessage}
        confirmText={t.leaveGameConfirm}
        cancelText={t.cancel}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </View>
  );
};

export default LeaveGameConfirm;
