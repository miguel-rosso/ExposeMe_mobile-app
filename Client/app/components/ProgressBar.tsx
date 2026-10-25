import React, { useEffect, useRef } from "react";
import { View, Animated } from "react-native";
import tw from "twrnc";

interface ProgressBarProps {
  duration: number;
  /** Called once when the bar fills up (not when it is unmounted or restarted first) */
  onEnd?: () => void;
}

const ProgressBar: React.FC<ProgressBarProps> = ({ duration, onEnd }) => {
  const progress = useRef(new Animated.Value(0)).current;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: duration,
      useNativeDriver: false,
    }).start(({ finished }) => { if (finished) onEndRef.current?.(); });
  }, [duration]);

  return (
    <View style={tw`h-2 bg-gray-300 rounded-full overflow-hidden`}>
      <Animated.View
        style={[
          tw`h-full bg-green-500`,
          {
            width: progress.interpolate({
              inputRange: [0, 1],
              outputRange: ["0%", "100%"],
            }),
          },
        ]}
      />
    </View>
  );
};

export default ProgressBar;
