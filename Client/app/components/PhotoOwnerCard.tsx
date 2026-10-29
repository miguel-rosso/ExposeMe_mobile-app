import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, View, Text } from "react-native";
import Icon from "react-native-vector-icons/FontAwesome";
import tw from "twrnc";
import { useI18n } from "../i18n";
import { TEST_IDS } from "../utils/testIds";

// Short bounce-in when the scoreboard appears, well within the 5 s of scores: it fades in during the first 60% while
// its scale overshoots and settles (the keyframes of react-native-animatable's bounceIn, with its default easing)
const ENTRANCE_DURATION_MS = 700;
const ENTRANCE_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
const ENTRANCE_OPACITY = { inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] };
const ENTRANCE_SCALE = { inputRange: [0, 0.2, 0.4, 0.6, 0.8, 1], outputRange: [0.3, 1.1, 0.9, 1.03, 0.97, 1] };
// A long name (up to 20 characters) shrinks down to this scale to stay on one line on small phones
const MIN_NAME_SCALE = 0.5;

/**
 * The card's entrance, all on the native driver: it starts after the scoreboard's first commit and no frame of it comes
 * back through React. (react-native-animatable set its first frame as the card mounted, which re-rendered the card in a
 * second commit before the scoreboard could be painted, EXP-311.) Without `animate` the card is drawn at its final
 * opacity and scale from the first frame.
 */
const useBounceIn = (animate: boolean) => {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const style = useMemo(() => ({
    opacity: progress.interpolate(ENTRANCE_OPACITY),
    transform: [{ scale: progress.interpolate(ENTRANCE_SCALE) }],
  }), [progress]);

  useEffect(() => {
    if (!animate) return;
    Animated.timing(progress, {
      toValue: 1, duration: ENTRANCE_DURATION_MS, easing: ENTRANCE_EASING, useNativeDriver: true,
    }).start();
    // Only when the card mounts (the scoreboard appears): a later change of the setting doesn't replay it
  }, []);

  return style;
};

interface PhotoOwnerCardProps {
  /** Whose photo it was (the revealed answer) */
  owner: string;
  /** The photo was mine: says "It was your photo!" instead of my name (I only learn it now, EXP-252) */
  isMine: boolean;
  /** False when the system asks to reduce motion: the card appears without bouncing in */
  animate: boolean;
}

/** Highlighted card at the top of the round scoreboard: whose photo it was, with the name in large type. */
const PhotoOwnerCard: React.FC<PhotoOwnerCardProps> = ({ owner, isMine, animate }) => {
  const { t } = useI18n();
  const entrance = useBounceIn(animate);
  return (
    <Animated.View
      testID={TEST_IDS.scoreAnswerCard}
      style={[
        tw`w-11/12 max-w-[500px] mb-4 px-5 py-3 items-center rounded-3xl bg-[#e63a35] border-2 border-white shadow-lg`,
        entrance,
      ]}
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
    </Animated.View>
  );
};

export default PhotoOwnerCard;
