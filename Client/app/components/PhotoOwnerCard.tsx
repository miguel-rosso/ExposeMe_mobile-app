import React from "react";
import { View, Text } from "react-native";
import * as Animatable from "react-native-animatable";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";

// Short entrance when the scoreboard appears, well within the 5 s of scores
const ENTRANCE_ANIMATION = "bounceIn";
const ENTRANCE_DURATION_MS = 700;
// A long name (up to 20 characters) shrinks down to this scale to stay on one line on small phones
const MIN_NAME_SCALE = 0.5;

interface PhotoOwnerCardProps {
  /** Whose photo it was (the revealed answer) */
  owner: string;
  /** The photo was mine: says "It was your photo!" instead of my name (I only learn it now, EXP-252) */
  isMine: boolean;
}

/** Highlighted card at the top of the round scoreboard: whose photo it was, with the name in large type. */
const PhotoOwnerCard: React.FC<PhotoOwnerCardProps> = ({ owner, isMine }) => {
  const { t } = useI18n();
  return (
    <Animatable.View
      testID={TEST_IDS.scoreAnswerCard}
      animation={ENTRANCE_ANIMATION}
      duration={ENTRANCE_DURATION_MS}
      useNativeDriver
      style={tw`w-11/12 max-w-[500px] mb-4 px-5 py-3 items-center rounded-3xl bg-[#e63a35] border-2 border-white shadow-lg`}
    >
      {!isMine && (
        <View style={tw`flex-row items-center`}>
          <Icon name="camera" size={14} color="white" style={tw`mr-2`} />
          <Text style={tw`text-white text-sm font-semibold uppercase tracking-wide`}>{t.photoWasFrom}</Text>
        </View>
      )}
      <Text
        testID={TEST_IDS.scoreAnswerName}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={MIN_NAME_SCALE}
        style={tw`text-white text-3xl font-extrabold text-center ${isMine ? "" : "mt-1"}`}
      >
        {isMine ? t.itWasYourPhoto : owner}
      </Text>
    </Animatable.View>
  );
};

export default PhotoOwnerCard;
