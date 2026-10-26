import React, { useEffect, useRef } from "react";
import { View, Animated } from "react-native";
import tw from "twrnc";

interface ProgressBarProps {
  duration: number;
  /** Called once when the bar fills up (not when it is unmounted or restarted first) */
  onEnd?: () => void;
}

// The fill is full width, scaled horizontally from its left edge: a transform runs on the native driver, so the bar
// costs no JS work (nor commits) per frame while the round's phases render (EXP-175, EXP-225)
const FILL_FROM_LEFT = { transformOrigin: "left" } as const;

const ProgressBar: React.FC<ProgressBarProps> = ({ duration, onEnd }) => {
  const progress = useRef(new Animated.Value(0)).current;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: duration,
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) onEndRef.current?.(); });
  }, [duration]);

  return (
    <View style={tw`h-2 bg-gray-300 rounded-full overflow-hidden`}>
      <Animated.View style={[tw`h-full w-full bg-green-500`, FILL_FROM_LEFT, { transform: [{ scaleX: progress }] }]} />
    </View>
  );
};

export default ProgressBar;
