import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing } from "react-native";
import tw from "twrnc";

/** How high a dot hops, in px */
export const DOT_LIFT = 5;
/** One hop: up, back down, then still until the end */
const HOP_MS = 1000;
/** Each cycle plays the hop and then the same hop backwards (like CSS `alternate`) */
export const DOT_CYCLE_MS = 2 * HOP_MS;
/** CSS "ease": the curve the dots always had (react-native-animatable's default) */
const EASE = Easing.bezier(0.25, 0.1, 0.25, 1);

/**
 * The cycle's progress (0→1) as the eased position along the hop: 0→1 on the way there, then exactly mirrored back to
 * 0. A timing's easing may go back and forth; with the native driver it is sampled once, before the loop starts. The
 * timing may still settle on its toValue (1) at a cycle's end: the keyframes keep the dot down there too.
 */
export const hopThereAndBack = (progress: number) => EASE(1 - Math.abs(1 - 2 * progress));

/** Position along the hop (0→1) to the dot's lift: up by 40%, back down by 80%, then still */
const HOP_KEYFRAMES = { inputRange: [0, 0.4, 0.8, 1], outputRange: [0, -DOT_LIFT, 0, 0] };

/**
 * A "waiting…" dot hopping forever, `delay` ms after it appears. The whole loop runs on the native driver: no work on
 * the JS thread once it started (EXP-396).
 */
const AnimatedDot = ({ delay = 0 }) => {
  const hop = useRef(new Animated.Value(0)).current;
  const lift = useMemo(() => hop.interpolate(HOP_KEYFRAMES), [hop]);

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(
        Animated.timing(hop, { toValue: 1, duration: DOT_CYCLE_MS, easing: hopThereAndBack, useNativeDriver: true }),
      ),
    ]);
    animation.start();
    return () => animation.stop();
  }, [delay]);

  return (
    <Animated.Text style={[tw`text-white text-xl`, { transform: [{ translateY: lift }] }]}>
      .
    </Animated.Text>
  );
};
export default AnimatedDot;
