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

  return (
    <Animated.View
      style={[
        tw`bg-black bg-opacity-60 rounded-xl px-3 py-2 mb-2 max-w-[85%] self-start ml-4`,
        { opacity, transform: [{ translateY }] },
      ]}
    >
      <Text style={tw`text-[#ff8605] font-bold text-sm`}>{username}</Text>
      <Text style={tw`text-white text-sm`}>{message}</Text>
    </Animated.View>
  );
};

export default ChatMessage;
