import React from "react";
import { Text, TouchableOpacity } from "react-native";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { fillTemplate } from "@/src/i18n/format";

const ICON_SIZE = 18;
// The icon-only button is small: a wider touch target, without moving the row's layout
const HIT_SLOP = 10;
// Muted stands out (the row's mark that this player is hidden); unmuted stays discreet
const MUTED_COLOR = "#ff8605"; // the brand orange, also the chat bubbles' names
const UNMUTED_COLOR_ON_LIGHT = "#9ca3af"; // gray-400, on the scoreboard's white rows
const UNMUTED_COLOR_ON_DARK = "rgba(255,255,255,0.6)"; // on the lobby rows and the pause modal's dark panel

interface MutePlayerButtonProps {
  username: string;
  muted: boolean;
  testID: string;
  /** Mutes or unmutes `username` on this device, at once (no confirmation) */
  onToggle: (username: string) => void;
  /** Drawn on a light background (the scoreboard's rows); else on a dark one */
  onLight?: boolean;
  /** A chip with the name next to the icon (the pause modal's awaited players); else the icon alone (a row) */
  withName?: boolean;
}

/**
 * Mutes another player on this device (EXP-422): their chat and emojis are hidden here only. The icon is the
 * row's muted mark too, and the button is named "Mute <name>" / "Unmute <name>" for screen readers.
 */
const MutePlayerButton: React.FC<MutePlayerButtonProps> = ({
  username, muted, testID, onToggle, onLight = false, withName = false,
}) => {
  const { t } = useI18n();
  const unmutedColor = onLight ? UNMUTED_COLOR_ON_LIGHT : UNMUTED_COLOR_ON_DARK;

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={fillTemplate(muted ? t.unmutePlayerNamed : t.mutePlayerNamed, { name: username })}
      accessibilityState={{ selected: muted }}
      onPress={() => onToggle(username)}
      hitSlop={withName ? undefined : HIT_SLOP}
      style={withName ? tw`flex-row items-center px-3 py-1 m-1 rounded-full bg-gray-700` : tw`ml-3`}
    >
      <Icon name={muted ? "volume-off" : "volume-up"} size={ICON_SIZE} color={muted ? MUTED_COLOR : unmutedColor} />
      {withName && <Text style={tw`text-white text-sm ml-2`} numberOfLines={1}>{username}</Text>}
    </TouchableOpacity>
  );
};

export default MutePlayerButton;
