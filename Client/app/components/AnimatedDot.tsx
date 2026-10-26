import React from "react";
import * as Animatable from "react-native-animatable";
import tw from "twrnc";
const AnimatedDot = ({ delay = 0 }) => (
  <Animatable.Text
    animation={{
      0: { translateY: 0 },
      0.4: { translateY: -5 },
      0.8: { translateY: 0 },
      1: { translateY: 0 },
    }}
    iterationCount="infinite"
    direction="alternate"
    delay={delay}
    style={tw`text-white text-xl`}
  >
    .
  </Animatable.Text>
);
export default AnimatedDot;
