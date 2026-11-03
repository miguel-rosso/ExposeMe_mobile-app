import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Image, ImageSourcePropType, Platform, Text, View } from "react-native";
import tw from "twrnc";
import bg2 from "@/assets/images/bg2.jpg";
import bg4 from "@/assets/images/bg4.jpg";
import bg6 from "@/assets/images/bg6.jpg";
import { BRAND_MASCOT_EMOJI } from "../theme/brand";

// ── Layout ──
export const HERO_HEIGHT = 180;
const CARD_WIDTH = 108;
const CARD_HEIGHT = 136;
/**
 * Blurred enough to read as "some photo" without showing anything concrete. Android blurs the decoded bitmap with a
 * 2-pass box blur at half the radius (in bitmap pixels), so it needs about 2.5x the iOS radius to look the same once
 * the bitmap is decoded at card size (EXP-275)
 */
export const CARD_BLUR_RADIUS = { ios: 8, android: 20 } as const;
const cardBlurRadius = () => (Platform.OS === "android" ? CARD_BLUR_RADIUS.android : CARD_BLUR_RADIUS.ios);

interface FanCard {
  source: ImageSourcePropType;
  /** Where the card ends up once fanned out, relative to the centred stack */
  rotateDeg: number;
  offsetX: number;
  offsetY: number;
}

/** Back cards first: the last one is drawn on top and carries the emoji badge */
export const FAN_CARDS: FanCard[] = [
  { source: bg4, rotateDeg: -12, offsetX: -62, offsetY: 10 },
  { source: bg6, rotateDeg: 12, offsetX: 62, offsetY: 10 },
  { source: bg2, rotateDeg: 0, offsetX: 0, offsetY: -4 },
];

// ── Motion ──
/** Fan-out spring: settles in about 450 ms with a slight overshoot */
const FAN_SPRING = { stiffness: 220, damping: 16, mass: 1 };
const EMOJI_POP_DELAY_MS = 200;
const EMOJI_POP_SPRING = { stiffness: 260, damping: 12, mass: 1 };

const fanOut = (progress: Animated.Value) =>
  Animated.spring(progress, { toValue: 1, ...FAN_SPRING, useNativeDriver: true });

const popIn = (scale: Animated.Value) =>
  Animated.sequence([
    Animated.delay(EMOJI_POP_DELAY_MS),
    Animated.spring(scale, { toValue: 1, ...EMOJI_POP_SPRING, useNativeDriver: true }),
  ]);

/** Stacked at progress 0, fanned out at 1 */
const cardMotion = (progress: Animated.Value, card: FanCard) => ({
  transform: [
    { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, card.offsetX] }) },
    { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, card.offsetY] }) },
    { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${card.rotateDeg}deg`] }) },
  ],
});

const CARD_SHADOW = {
  shadowColor: "#000",
  shadowOpacity: 0.45,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 10,
};

interface PhotoFanHeroProps {
  /** False when the system asks to reduce motion: the cards are shown already fanned out, with the emoji */
  animate: boolean;
}

/** Decorative hero of the first-run screen: three blurred "polaroids" fanning out, with the 😳 mascot on top */
const PhotoFanHero = ({ animate }: PhotoFanHeroProps) => {
  const fan = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const emojiScale = useRef(new Animated.Value(animate ? 0 : 1)).current;
  // Built once: re-renders (e.g. a language change) must not create new native interpolation nodes
  const cardStyles = useMemo(() => FAN_CARDS.map((card) => cardMotion(fan, card)), [fan]);

  useEffect(() => {
    if (!animate) {
      fan.stopAnimation();
      emojiScale.stopAnimation();
      fan.setValue(1);
      emojiScale.setValue(1);
      return;
    }
    const entrance = Animated.parallel([fanOut(fan), popIn(emojiScale)]);
    entrance.start();
    return () => entrance.stop();
  }, [animate]);

  const frontIndex = FAN_CARDS.length - 1;
  const blurRadius = cardBlurRadius();
  return (
    <View
      style={[tw`w-full items-center justify-center`, { height: HERO_HEIGHT }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {FAN_CARDS.map((card, i) => (
        <Animated.View
          key={i}
          style={[
            tw`absolute bg-white rounded-xl p-1.5`,
            { width: CARD_WIDTH, height: CARD_HEIGHT },
            CARD_SHADOW,
            cardStyles[i],
          ]}
        >
          {/* resizeMethod (Android only): decoded at card size, so the blur radius softens every photo alike instead of
              barely touching the high-resolution ones */}
          <Image
            source={card.source}
            blurRadius={blurRadius}
            resizeMethod="resize"
            resizeMode="cover"
            style={tw`flex-1 w-full rounded-lg`}
          />
          {i === frontIndex && (
            <Animated.View style={[tw`absolute -top-6 -right-6`, { transform: [{ scale: emojiScale }] }]}>
              <Text style={tw`text-[44px]`}>{BRAND_MASCOT_EMOJI}</Text>
            </Animated.View>
          )}
        </Animated.View>
      ))}
    </View>
  );
};

export default PhotoFanHero;
