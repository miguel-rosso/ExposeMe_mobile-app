import React from "react";
import { TouchableOpacity } from "react-native";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { TEST_IDS } from "@/app/utils/testIds";

interface CloseButtonProps {
  onPress: () => void;
}

const CloseButton: React.FC<CloseButtonProps> = ({ onPress }) => {
  return (
    <TouchableOpacity testID={TEST_IDS.closeButton} style={tw`absolute top-1 right-3 p-2 z-99`} onPress={onPress}>
      <Icon name="close" size={30} color="white" />
    </TouchableOpacity>
  );
};

export default CloseButton;
