import React from "react";
import { View, Text } from "react-native";
import * as Animatable from "react-native-animatable";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";

interface SuccessAlertProps {
  text: string;
}

const SuccessAlert: React.FC<SuccessAlertProps> = ({ text }) => (
  <Animatable.View animation="fadeIn" style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center`}>
    <View style={tw`px-6 py-4 rounded-xl bg-black bg-opacity-60 flex items-center`}>
      <Icon name="check-circle" size={40} color="#4ade80" style={tw`mb-1`} />
      <Text
        style={[
          tw`text-2xl text-green-400 font-bold`,
          { textShadowColor: "rgba(0, 0, 0, 0.5)", textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 },
        ]}
      >
        {text}
      </Text>
    </View>
  </Animatable.View>
);

export default SuccessAlert;
