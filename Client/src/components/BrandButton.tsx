import React from "react";
import { Text, TouchableOpacity } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import tw from "twrnc";
import { BRAND_GRADIENT } from "../theme/brand";

type BrandButtonProps = {
  testID: string;
  label: string;
  onPress: () => void;
};

/** A full-width primary button of the home screen: the brand's red gradient with a bold white label */
const BrandButton = ({ testID, label, onPress }: BrandButtonProps) => (
  <LinearGradient
    colors={BRAND_GRADIENT}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 0 }}
    style={tw`p-4 rounded-2xl mb-4 w-full`}
  >
    <TouchableOpacity testID={testID} style={tw`w-full`} onPress={onPress}>
      <Text style={tw`text-white text-center text-lg font-bold`}>{label}</Text>
    </TouchableOpacity>
  </LinearGradient>
);

export default BrandButton;
