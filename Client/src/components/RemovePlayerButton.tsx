import React from "react";
import { Text, TouchableOpacity } from "react-native";
import Icon from "@react-native-vector-icons/fontawesome/static";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { fillTemplate } from "@/src/i18n/format";

const ICON_SIZE = 16;
// The icon-only button is small: a wider touch target, without moving the row's layout
const HIT_SLOP = 10;
const ROW_ICON_COLOR = "#6b7280"; // gray-500, on the scoreboard's white rows
const CHIP_ICON_COLOR = "#fca5a5"; // red-300, on the pause modal's dark panel

interface RemovePlayerButtonProps {
  username: string;
  testID: string;
  /** Asks the host first (RemovePlayerConfirm); never removes by itself */
  onPress: (username: string) => void;
  /** A chip with the name next to the icon (the pause modal's awaited players); else the icon alone (a scoreboard row) */
  withName?: boolean;
}

/** The host's way to remove a player during the game (EXP-425), named "Remove <name>" for screen readers */
const RemovePlayerButton: React.FC<RemovePlayerButtonProps> = ({ username, testID, onPress, withName = false }) => {
  const { t } = useI18n();

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={fillTemplate(t.removePlayerNamed, { name: username })}
      onPress={() => onPress(username)}
      hitSlop={withName ? undefined : HIT_SLOP}
      style={withName ? tw`flex-row items-center px-3 py-1 m-1 rounded-full bg-gray-700` : tw`ml-3`}
    >
      <Icon name="user-times" size={ICON_SIZE} color={withName ? CHIP_ICON_COLOR : ROW_ICON_COLOR} />
      {withName && <Text style={tw`text-white text-sm ml-2`} numberOfLines={1}>{username}</Text>}
    </TouchableOpacity>
  );
};

export default RemovePlayerButton;
