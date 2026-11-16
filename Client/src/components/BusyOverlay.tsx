import React from "react";
import { Text, View } from "react-native";
import * as Animatable from "react-native-animatable";
import Icon from "@react-native-vector-icons/fontawesome/static";
import tw from "twrnc";

/** One full turn of the spinner */
const SPIN_DURATION_MS = 1500;

interface BusyOverlayProps {
  title: string;
  subtitle?: string;
  testID?: string;
}

/** Dims the whole screen with a spinner and what it is waiting for (e.g. the room, the gallery picker). */
const BusyOverlay = ({ title, subtitle, testID }: BusyOverlayProps) => (
  <View testID={testID} style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}>
    <View style={tw`px-8 py-6 rounded-xl bg-gray-800 flex items-center`}>
      <Animatable.View animation="rotate" iterationCount="infinite" easing="linear" duration={SPIN_DURATION_MS}>
        <Icon name="spinner" size={40} color="white" />
      </Animatable.View>
      <Text style={tw`text-white mt-4 text-lg font-bold`}>{title}</Text>
      {subtitle ? <Text style={tw`text-white mt-2 text-sm opacity-70`}>{subtitle}</Text> : null}
    </View>
  </View>
);

export default BusyOverlay;
