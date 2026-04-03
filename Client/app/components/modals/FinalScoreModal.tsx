import React, { useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, FlatList, Animated, Dimensions } from "react-native";
import tw from "twrnc";
import { ScoreRound } from "@/app/models/interfaces";
import { useRouter } from "expo-router";
import { useGameContext } from "@/app/providers/GameContext";
import { Ionicons } from "@expo/vector-icons";
import * as Animatable from "react-native-animatable";
import LottieView from "lottie-react-native";
import { LinearGradient } from "expo-linear-gradient";

interface FinalScoreModalProps {
  visible: boolean;
  finalScore: ScoreRound[];
}

const { width } = Dimensions.get("window");

const ACCENT = "#A78BFA"; // soft violet
const ACCENT_DIM = "rgba(167, 139, 250, 0.15)";
const GOLD = "#FACC15";
const SILVER = "#94A3B8";
const BRONZE = "#D97706";

const FinalScoreModal: React.FC<FinalScoreModalProps> = ({ visible, finalScore }) => {
  const navigation = useRouter();
  const { setRoundsOfGame, setPlayersProvider, endSocket } = useGameContext();
  const slideAnim = useRef(new Animated.Value(300)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const confettiRef = useRef<LottieView>(null);

  const sortedScores = [...finalScore].sort((a, b) => b.points - a.points);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          tension: 50,
          friction: 12,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
      ]).start();

      if (confettiRef.current) {
        confettiRef.current.play();
      }
    } else {
      slideAnim.setValue(300);
      fadeAnim.setValue(0);
    }
  }, [visible]);

  const onClose = () => {
    setRoundsOfGame(0);
    setPlayersProvider([]);
    navigation.replace("/");
  };

  const playAgain = () => {
    navigation.replace("/screens/WaitingRoom");
  };

  const getRankAccent = (index: number) => {
    if (index === 0) return GOLD;
    if (index === 1) return SILVER;
    if (index === 2) return BRONZE;
    return "#4B5563";
  };

  const renderScore = ({ item, index }: { item: ScoreRound; index: number }) => {
    const isWinner = index === 0;
    const accent = getRankAccent(index);

    return (
      <Animatable.View animation="fadeInUp" delay={index * 150} duration={500}>
        <View
          style={[
            tw`flex-row items-center py-3 px-4 mb-2 rounded-2xl`,
            {
              backgroundColor: isWinner ? "rgba(250, 204, 21, 0.08)" : "rgba(255, 255, 255, 0.03)",
              borderWidth: 1,
              borderColor: isWinner ? "rgba(250, 204, 21, 0.25)" : "rgba(255, 255, 255, 0.06)",
            },
          ]}
        >
          {/* Rank */}
          <View
            style={[
              tw`h-9 w-9 rounded-xl items-center justify-center mr-3`,
              {
                backgroundColor: index < 3 ? `${accent}20` : "rgba(255,255,255,0.05)",
                borderWidth: 1.5,
                borderColor: index < 3 ? `${accent}50` : "rgba(255,255,255,0.08)",
              },
            ]}
          >
            <Text
              style={[
                tw`text-sm font-bold`,
                { color: index < 3 ? accent : "#6B7280", fontVariant: ["tabular-nums"] },
              ]}
            >
              {index + 1}
            </Text>
          </View>

          {/* Name */}
          <View style={tw`flex-1`}>
            <Text
              style={[
                tw`text-base font-semibold`,
                { color: isWinner ? "#FAFAFA" : "#D1D5DB", letterSpacing: 0.3 },
              ]}
              numberOfLines={1}
            >
              {item.username}
            </Text>
          </View>

          {/* Points */}
          <View style={tw`flex-row items-center`}>
            <Text
              style={[
                tw`text-lg font-bold mr-1`,
                { color: accent, fontVariant: ["tabular-nums"], letterSpacing: 0.5 },
              ]}
            >
              {item.points}
            </Text>
            <Text style={[tw`text-xs`, { color: "#6B7280" }]}>pts</Text>
          </View>
        </View>
      </Animatable.View>
    );
  };

  if (!visible) return null;

  return (
    <View style={tw`absolute inset-0 flex-1 justify-center items-center z-100`}>
      {/* Confetti */}
      <View style={[tw`absolute inset-0`, { zIndex: 1 }]}>
        <LottieView
          ref={confettiRef}
          source={require("@/assets/animations/confetiAnimation.json")}
          autoPlay
          loop={false}
          style={{ width: "100%", height: "100%" }}
        />
      </View>

      {/* Backdrop */}
      <Animated.View
        style={[tw`absolute inset-0`, { backgroundColor: "rgba(0,0,0,0.92)", opacity: fadeAnim, zIndex: 2 }]}
      />

      {/* Content */}
      <Animated.View
        style={[
          tw`w-[88%] max-w-[440px] rounded-3xl overflow-hidden`,
          {
            transform: [{ translateY: slideAnim }],
            zIndex: 3,
            maxHeight: "85%",
            backgroundColor: "#111318",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.08)",
          },
        ]}
      >
        {/* Header */}
        <View style={[tw`pt-8 pb-5 items-center`, { backgroundColor: "#111318" }]}>
          <Animatable.View animation="fadeIn" delay={200}>
            <View
              style={[
                tw`h-16 w-16 rounded-2xl items-center justify-center mb-4`,
                { backgroundColor: ACCENT_DIM, borderWidth: 1, borderColor: "rgba(167, 139, 250, 0.3)" },
              ]}
            >
              <Ionicons name="trophy" size={30} color={ACCENT} />
            </View>
          </Animatable.View>

          <Text style={[tw`text-xs font-semibold tracking-widest mb-1`, { color: ACCENT, letterSpacing: 3 }]}>
            GAME OVER
          </Text>
          <Text style={[tw`text-2xl font-bold`, { color: "#FAFAFA", letterSpacing: 0.5 }]}>Final Results</Text>

          {/* Winner highlight */}
          {sortedScores.length > 0 && (
            <Animatable.View animation="fadeIn" delay={400} style={tw`mt-3 items-center`}>
              <View
                style={[
                  tw`flex-row items-center px-5 py-2 rounded-full`,
                  { backgroundColor: "rgba(250, 204, 21, 0.1)", borderWidth: 1, borderColor: "rgba(250, 204, 21, 0.2)" },
                ]}
              >
                <Ionicons name="star" size={14} color={GOLD} style={tw`mr-2`} />
                <Text style={[tw`text-sm font-bold`, { color: GOLD }]}>
                  {sortedScores[0].username}
                </Text>
              </View>
            </Animatable.View>
          )}
        </View>

        {/* Divider */}
        <View style={[tw`mx-6`, { height: 1, backgroundColor: "rgba(255,255,255,0.06)" }]} />

        {/* Scores list */}
        <View style={tw`px-5 pt-4 pb-2 max-h-64`}>
          <FlatList
            data={sortedScores}
            renderItem={renderScore}
            keyExtractor={(item) => item.username}
            showsVerticalScrollIndicator={false}
          />
        </View>

        {/* Buttons */}
        <View style={tw`flex-row px-5 pb-6 pt-2`}>
          <TouchableOpacity
            onPress={onClose}
            style={[
              tw`flex-1 py-3.5 rounded-2xl items-center justify-center mr-2`,
              {
                backgroundColor: "rgba(255,255,255,0.05)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.1)",
              },
            ]}
            activeOpacity={0.7}
          >
            <Text style={[tw`text-sm font-semibold`, { color: "#9CA3AF" }]}>Exit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={playAgain}
            style={[
              tw`flex-1 py-3.5 rounded-2xl items-center justify-center ml-2`,
              { backgroundColor: ACCENT },
            ]}
            activeOpacity={0.7}
          >
            <Text style={[tw`text-sm font-bold`, { color: "#0F0F14" }]}>Play Again</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
};

export default FinalScoreModal;
