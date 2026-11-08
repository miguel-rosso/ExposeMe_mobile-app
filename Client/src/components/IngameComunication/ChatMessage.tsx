import React, { useEffect, useRef } from "react";
import { Text, Animated, TouchableOpacity, View } from "react-native";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { fillTemplate } from "@/src/i18n/format";
import { chatReportId } from "@/src/utils/testIds";

const REPORT_ICON_SIZE = 12;
/**
 * The flag's touch target: a box of its own at least this big (Android's minimum), at the bubble's right edge, inside
 * the bubble (Android never sends a touch outside a view's parent, so a hitSlop past it would not count). The bubble
 * keeps that much room on its right for it; with its padding and two lines it is taller than the box.
 */
export const REPORT_TOUCH_TARGET = 48;
/**
 * Lines of a message a bubble shows, the rest cut with an ellipsis (EXP-447): the server keeps at most 3 line breaks
 * (Server/managers/chatText.ts), and a 100-character message still wraps, so one bubble never covers the chat area.
 */
export const MESSAGE_MAX_LINES = 4;

interface ChatMessageProps {
  username: string;
  message: string;
  onAnimationEnd: () => void;
  /** Another player's message (EXP-423): a flag at the bubble's right opens the report dialog. Mine have none */
  onReport?: () => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ username, message, onAnimationEnd, onReport }) => {
  const { t } = useI18n();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-10)).current;

  useEffect(() => {
    // Animation sequence: fade in, hold, fade out
    Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(5000), // Show for 5 seconds
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -10,
          duration: 300,
          useNativeDriver: true,
        }),
      ]),
    ]).start(() => {
      onAnimationEnd();
    });
  }, []);

  // Near-opaque with a light edge: the bubble sits over the lobby's controls (Start button, rounds pill, «Waiting…»),
  // whose text would otherwise show through and mix with the message (EXP-416). Taps go through it to them (its texts sit
  // in views that never take a touch), except on its report flag
  return (
    <Animated.View
      style={[
        tw`bg-black/95 border border-white/20 rounded-xl px-3 py-2 mb-2 max-w-[85%] self-center`,
        { opacity, transform: [{ translateY }], pointerEvents: "box-none" },
        onReport && { paddingRight: REPORT_TOUCH_TARGET, minHeight: REPORT_TOUCH_TARGET },
      ]}
    >
      <View style={{ pointerEvents: "none" }}>
        <Text style={tw`text-[#ff8605] font-bold text-sm`} numberOfLines={1}>{username}</Text>
        <Text style={tw`text-white text-sm`} numberOfLines={MESSAGE_MAX_LINES}>{message}</Text>
      </View>
      {onReport && (
        <TouchableOpacity
          testID={chatReportId(username)}
          accessibilityRole="button"
          accessibilityLabel={fillTemplate(t.reportMessageFrom, { name: username })}
          onPress={onReport}
          style={[
            tw`absolute top-0 right-0 bottom-0 items-center justify-center`,
            { width: REPORT_TOUCH_TARGET, minHeight: REPORT_TOUCH_TARGET },
          ]}
        >
          <Icon name="flag" size={REPORT_ICON_SIZE} color="rgba(255,255,255,0.6)" />
        </TouchableOpacity>
      )}
    </Animated.View>
  );
};

export default ChatMessage;
