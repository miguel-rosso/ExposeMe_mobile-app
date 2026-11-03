import React from "react";
import { View } from "react-native";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { TEST_IDS } from "@/src/utils/testIds";
import AlertModal from "./AlertModal";

interface RemovePlayerConfirmProps {
  /** The player the host asked to remove, or null when not asking */
  username: string | null;
  /** Remove them (remove-player) */
  onConfirm: (username: string) => void;
  /** Keep them */
  onCancel: () => void;
}

/**
 * The host's "Are you sure you want to remove @name from the room?" during the game (EXP-425), the lobby's question.
 * Its own layer above every overlay of the game screen (the pause modal, the scoreboard), like LeaveGameConfirm.
 */
const RemovePlayerConfirm: React.FC<RemovePlayerConfirmProps> = ({ username, onConfirm, onCancel }) => {
  const { t } = useI18n();
  if (username === null) return null;

  return (
    <View testID={TEST_IDS.removePlayerConfirm} accessibilityViewIsModal style={tw`absolute inset-0 z-110`}>
      <AlertModal
        visible
        title={t.confirmRemovePlayer}
        message={t.areYouSureRemove}
        highlightedText={`@${username}`}
        confirmText={t.remove}
        cancelText={t.cancel}
        onConfirm={() => onConfirm(username)}
        onCancel={onCancel}
      />
    </View>
  );
};

export default RemovePlayerConfirm;
