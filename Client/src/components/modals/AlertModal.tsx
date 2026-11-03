import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import * as Animatable from "react-native-animatable";
import { TEST_IDS } from "@/src/utils/testIds";
import { splitHighlightTemplate } from "@/src/utils/highlightTemplate";

interface AlertOverlayProps {
  visible: boolean;
  title: string;
  /** May contain {name}: where highlightedText is painted (after the message when absent) */
  message: string;
  highlightedText?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmButtonColor?: string;
  cancelButtonColor?: string;
}

const AlertMessage = ({ message, highlightedText }: Pick<AlertOverlayProps, "message" | "highlightedText">) => {
  const style = tw`text-lg text-white text-center mb-6`;
  if (!highlightedText) return <Text style={style}>{message}</Text>;
  const { before, highlight, after } = splitHighlightTemplate(message, highlightedText);
  return (
    <Text style={style}>
      {before}
      <Text style={tw`text-red-500`}>{highlight}</Text>
      {after}
    </Text>
  );
};

const AlertOverlay: React.FC<AlertOverlayProps> = ({
  visible,
  title,
  message,
  highlightedText,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  confirmButtonColor = "bg-red-600",
  cancelButtonColor = "bg-blue-500",
}) => {
  if (!visible) {
    return null;
  }

  return (
    <Animatable.View
      testID={TEST_IDS.alertModal}
      animation="fadeIn"
      duration={300}
      style={tw`absolute top-0 left-0 right-0 bottom-0 z-50 flex justify-center items-center bg-black bg-opacity-50`}
    >
      <Animatable.View animation="zoomIn" duration={300} style={tw`rounded-lg p-6 bg-gray-800 w-4/5 max-w-[500px]`}>
        <Text style={tw`text-2xl text-white font-bold text-center mb-4`}>{title}</Text>
        <AlertMessage message={message} highlightedText={highlightedText} />
        <View style={tw`flex-row justify-evenly`}>
          <TouchableOpacity testID={TEST_IDS.alertModalCancel} onPress={onCancel} style={tw`${cancelButtonColor} px-4 py-2 rounded-lg`}>
            <Text style={tw`text-white text-lg`}>{cancelText}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID={TEST_IDS.alertModalConfirm} onPress={onConfirm} style={tw`${confirmButtonColor} px-4 py-2 rounded-lg`}>
            <Text style={tw`text-white text-lg`}>{confirmText}</Text>
          </TouchableOpacity>
        </View>
      </Animatable.View>
    </Animatable.View>
  );
};

export default AlertOverlay;
