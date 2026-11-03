import React, { useEffect, useRef } from "react";
import { Text, Animated } from "react-native";
import tw from "twrnc";

interface ChatMessageProps {
  username: string;
  message: string;
  onAnimationEnd: () => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ username, message, onAnimationEnd }) => {
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
  // whose text would otherwise show through and mix with the message (EXP-416)
  return (
    <Animated.View
      style={[
        tw`bg-black/95 border border-white/20 rounded-xl px-3 py-2 mb-2 max-w-[85%] self-center`,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      <Text style={tw`text-[#ff8605] font-bold text-sm`}>{username}</Text>
      <Text style={tw`text-white text-sm`}>{message}</Text>
    </Animated.View>
  );
};

export default ChatMessage;
