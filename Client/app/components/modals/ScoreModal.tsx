import React, { memo } from "react";
import { View, Text, ScrollView } from "react-native";
import tw from "twrnc";
import { ScoreRound } from "../../models/interfaces";
import Icon from "react-native-vector-icons/FontAwesome";
import { useI18n } from "../../i18n";
import { TEST_IDS, scoreGuessId, scoreRankId } from "@/app/utils/testIds";
import { rankScores } from "@/app/utils/ranking";
import { isRevealedOwner } from "@/app/utils/roundState";
import PhotoOwnerCard from "@/app/components/PhotoOwnerCard";

// Space kept free under the list for the photo owner's hold button (GameScreen: bottom-24 + ~64 dp button)
export const HOLD_BUTTON_CLEARANCE = 176;
// From this many players on the rows get tighter so more fit before scrolling
const COMPACT_FROM = 7;

interface ScoreModalProps {
  visible: boolean;
  scoreRound: ScoreRound[];
  rounds: { round: number; roundsOfGame: number };
  correctAnswer: string;
  /** This device's player: if the photo was theirs, the card says "It was your photo!" */
  myUsername?: string;
  /** The photo owner's hold button is on screen: keep the list clear of it */
  reserveHoldButton?: boolean;
}

const ScoreModal: React.FC<ScoreModalProps> = ({
  visible,
  scoreRound,
  rounds,
  correctAnswer,
  myUsername,
  reserveHoldButton = false,
}) => {
  const { t } = useI18n();

  if (!visible) {
    return null;
  }

  const ranked = rankScores(scoreRound);
  const compact = ranked.length >= COMPACT_FROM;

  return (
    <View
      testID={TEST_IDS.scoreModal}
      style={[
        tw`absolute inset-0 justify-center items-center bg-black bg-opacity-50 pt-20 pb-16 z-50`,
        reserveHoldButton && { paddingBottom: HOLD_BUTTON_CLEARANCE },
      ]}
    >
      <Text testID={TEST_IDS.scoreRoundTitle} style={tw`text-xl text-white absolute top-10 font-bold mb-4`}>
        {t.roundOf.replace("{round}", String(rounds.round)).replace("{total}", String(rounds.roundsOfGame))}
      </Text>

      {correctAnswer !== "" && (
        <PhotoOwnerCard owner={correctAnswer} isMine={isRevealedOwner(correctAnswer, myUsername)} />
      )}

      {/* Shrinks to the space left (never grows past its rows) and scrolls: 12 players don't fit small phones */}
      <ScrollView
        testID={TEST_IDS.scoreList}
        style={tw`w-full flex-grow-0`}
        contentContainerStyle={tw`items-center`}
        showsVerticalScrollIndicator={false}
      >
        {ranked.map((player) => {
          // Everyone's guess, the photo owner's too (they vote like everyone, EXP-252)
          const icon = player.lastAnswerCorrect ? "check-circle" : "times-circle";
          const color = player.lastAnswerCorrect ? "green" : "red";
          const textColor = player.lastAnswerCorrect ? "text-green-500" : "text-red-500";
          const label = player.lastGuess || t.noGuess;
          return (
            <View
              key={player.username}
              style={tw`w-11/12 max-w-[500px] bg-white ${compact ? "mb-1 mx-1" : "mb-2 m-1"} rounded-3xl`}
            >
              <View style={tw`flex-row ${compact ? "h-11" : "h-12"}`}>
                <View style={tw`flex items-center w-[12%] min-w-[40px] justify-center rounded-l-full bg-[#e63a35]`}>
                  <Text testID={scoreRankId(player.username)} style={tw`text-lg text-white font-bold`}>{player.rank}</Text>
                </View>
                <View style={tw`flex-row px-2 pr-4 items-center flex-1 justify-between`}>
                  <View>
                    <Text style={tw`text-lg font-bold`}>{player.username}</Text>
                    <View style={tw`flex-row items-center`}>
                      <Icon style={tw`px-2`} name={icon} size={12} color={color} />
                      <Text testID={scoreGuessId(player.username)} style={tw`text-xs ${textColor}`}>
                        {label}
                      </Text>
                    </View>
                  </View>
                  <Text style={tw`text-lg`}>{player.points}</Text>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
};

// Memoised: during scores the game screen still re-renders (reactions, the hold button), the scoreboard doesn't change
export default memo(ScoreModal);
