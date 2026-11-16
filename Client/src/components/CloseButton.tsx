import React from "react";
import { TouchableOpacity } from "react-native";
import Icon from "@react-native-vector-icons/fontawesome/static";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { TEST_IDS } from "@/src/utils/testIds";

interface CloseButtonProps {
  onPress: () => void;
  /** What the screen reader announces; "Close" unless the screen says what closing does (e.g. leave the room) */
  accessibilityLabel?: string;
}

const CloseButton: React.FC<CloseButtonProps> = ({ onPress, accessibilityLabel }) => {
  const { t } = useI18n();

  return (
    <TouchableOpacity
      testID={TEST_IDS.closeButton}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? t.close}
      style={tw`absolute top-1 right-3 p-2 z-99`}
      onPress={onPress}
    >
      <Icon name="close" size={30} color="white" />
    </TouchableOpacity>
  );
};

export default CloseButton;
