import React, { useEffect, useRef, useState } from "react";
import { View, Text, Animated, Dimensions, TouchableOpacity, ScrollView } from "react-native";
import tw from "twrnc";
import LottieView from "lottie-react-native";
import * as Animatable from "react-native-animatable";
import { ScoreRound } from "@/src/models/interfaces";
import { useI18n } from "../../i18n";
import { TEST_IDS, winnerNameId } from "@/src/utils/testIds";

// Get screen dimensions
const { width, height } = Dimensions.get("window");

interface WinnerModalProps {
  visible: boolean;
  /** Every player tied for first place (one entry when there is no tie). */
  winners: ScoreRound[];
  onAnimationEnd: () => void;
}

const WinnerModal: React.FC<WinnerModalProps> = ({ visible, winners, onAnimationEnd }) => {
  const { t } = useI18n();
  const medalAnimation = useRef<LottieView>(null);
  const confettiAnimation = useRef<LottieView>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [animationComplete, setAnimationComplete] = useState(false);

  useEffect(() => {
    if (visible) {
      // The socket stays open through game over: the player is still in the room (Play again rejoins it as is)
      // Play the animations
      if (medalAnimation.current) {
        medalAnimation.current.play();
      }
      if (confettiAnimation.current) {
        confettiAnimation.current.play();
      }

      // Animate the text
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.delay(3500), // Give time for animations to play
      ]).start(() => {
        setAnimationComplete(true);
        // Don't automatically proceed - let user tap to continue
      });
    } else {
      // Reset animations for next time
      fadeAnim.setValue(0);
      setAnimationComplete(false);
    }
  }, [visible]);

  if (winners.length === 0 || !visible) return null;

  const isTie = winners.length > 1;

  return (
    <View testID={TEST_IDS.winnerModal} style={tw`absolute top-0 left-0 right-0 bottom-0 z-100`}>
      <TouchableOpacity accessible={false} activeOpacity={1} style={tw`flex-1`} onPress={animationComplete ? onAnimationEnd : undefined}>
        {/* Main container with black semi-transparent background */}
        <View style={tw`flex-1 bg-black bg-opacity-95`}>
          {/* Confetti covering the entire screen */}
          <LottieView
            ref={confettiAnimation}
            source={require("@/assets/animations/confetiAnimation.json")}
            style={{
              position: "absolute",
              width: width * 1.2, // Make it slightly larger than screen
              height: height * 1.2,
              left: -width * 0.1, // Center the enlarged animation
              top: -height * 0.1,
              zIndex: 1, // Ensure confetti is behind other content but above background
            }}
            autoPlay={false}
            loop={true}
            resizeMode="cover"
          />

          {/* Main content with z-index to be above confetti */}
          <View style={[tw`flex-1 justify-center items-center pb-16`, { zIndex: 2 }]}>
            {/* Gold medal animation */}
            <LottieView
              ref={medalAnimation}
              source={require("@/assets/animations/GoldMedalAnimation.json")}
              style={isTie ? tw`size-40` : tw`size-64`}
              autoPlay={false}
              loop={false}
            />

            {/* Winner text with animated entrance */}
            <Animated.View style={[tw`items-center`, { opacity: fadeAnim }]}>
              <Text testID={TEST_IDS.winnerTitle} style={tw`text-yellow-400 text-xl font-bold mb-2`}>
                {isTie ? t.winners : t.winner}
              </Text>
              {isTie && <Text style={tw`text-white text-base opacity-80 mb-2`}>{t.tie}</Text>}
              {/* Tied winners can be many: cap the list height and let it scroll on small screens */}
              <ScrollView
                style={{ maxHeight: height * 0.3, width: width * 0.9 }}
                contentContainerStyle={tw`items-center`}
                showsVerticalScrollIndicator={false}
              >
                {winners.map((w) => (
                  <Animatable.Text
                    key={w.username}
                    testID={winnerNameId(w.username)}
                    animation={animationComplete ? "pulse" : undefined}
                    iterationCount="infinite"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={tw`text-white ${isTie ? "text-3xl" : "text-4xl"} font-extrabold text-center`}
                  >
                    {w.username}
                  </Animatable.Text>
                ))}
              </ScrollView>

              <Animatable.Text animation="fadeIn" delay={1000} style={tw`text-yellow-400 text-2xl font-bold mt-4`}>
                {(winners[0].points === 1 ? t.pointsOne : t.points).replace("{points}", String(winners[0].points))}
              </Animatable.Text>
            </Animated.View>

            {/* "Tap anywhere" text positioned absolutely at the bottom of the screen */}
            {animationComplete && (
              <Animatable.View
                testID={TEST_IDS.winnerContinue}
                animation="fadeIn"
                style={tw`absolute bottom-20 w-full items-center`} // Moved higher to avoid emoji bar
              >
                <Text style={tw`text-white text-lg opacity-70`}>{t.tapToContinue}</Text>
              </Animatable.View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
};

export default WinnerModal;
