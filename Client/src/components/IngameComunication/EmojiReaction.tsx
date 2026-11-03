import React, { memo, useEffect, useRef } from "react";
import { Text, Animated } from "react-native";
import tw from "twrnc";
import { SCREENSHOT_EMOJI } from "../../utils/reactions";

interface EmojiReactionProps {
  id: string;
  username: string;
  emoji: string;
  // Translated text shown after the screenshot emoji ("took a screenshot")
  screenshotLabel?: string;
  // Called with `id` when the pill's animation ends, which may be after newer reactions pushed it out of the lane:
  // one stable handler for every pill
  onAnimationEnd: (id: string) => void;
}

const EmojiReaction: React.FC<EmojiReactionProps> = ({ id, username, emoji, screenshotLabel, onAnimationEnd }) => {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-10)).current;
  const isScreenshot = emoji === SCREENSHOT_EMOJI;

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
      Animated.delay(2000), // Show for 2 seconds
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
      onAnimationEnd(id);
    });
  }, []);

  return (
    <Animated.View
      style={[
        tw`bg-black bg-opacity-40 rounded-full px-3 py-1 flex-row items-center justify-center mb-2`,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      <Text style={tw`text-white font-medium ${isScreenshot ? "text-xs" : "text-sm"} mr-1`}>{username}</Text>
      <Text style={tw`${isScreenshot ? "text-sm" : "text-2xl"} text-white`}>{isScreenshot && screenshotLabel ? `${emoji} ${screenshotLabel}` : emoji}</Text>
    </Animated.View>
  );
};

// Memoised: a pill already on screen does not re-render when others arrive or leave the lane (EXP-393)
export default memo(EmojiReaction);
