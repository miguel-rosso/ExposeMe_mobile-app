import React from "react";
import { TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/fontawesome/static";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { TEST_IDS } from "@/src/utils/testIds";
import { LEAVE_BUTTON } from "@/src/utils/gameRows";

const ICON_SIZE = 16;

interface ReportPhotoButtonProps {
  /** Opens the report dialog for the round's photo; never reports by itself */
  onPress: () => void;
}

/**
 * «Report» on the round's photo (EXP-423): a small flag in the bottom-right corner, in the Exit button's strip under the
 * emoji row (see gameRows), so it covers no answer, button or scoreboard row. Named "Report photo" for screen readers.
 */
const ReportPhotoButton: React.FC<ReportPhotoButtonProps> = ({ onPress }) => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  return (
    <TouchableOpacity
      testID={TEST_IDS.reportPhotoButton}
      accessibilityRole="button"
      accessibilityLabel={t.reportPhoto}
      onPress={onPress}
      style={[
        tw`absolute z-80 items-center justify-center rounded-full bg-gray-800 bg-opacity-80`,
        {
          bottom: insets.bottom + LEAVE_BUTTON.bottom, right: insets.right + LEAVE_BUTTON.side,
          height: LEAVE_BUTTON.height, width: LEAVE_BUTTON.height,
        },
      ]}
    >
      <Icon name="flag" size={ICON_SIZE} color="white" />
    </TouchableOpacity>
  );
};

export default ReportPhotoButton;
