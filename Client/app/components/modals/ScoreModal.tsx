import React from "react";
import { View, Text, Animated } from "react-native";
import tw from "twrnc";
import { ScoreRound } from "../../models/interfaces";
import Icon from "react-native-vector-icons/FontAwesome";

interface ScoreModalProps {
  visible: boolean;
  scoreRound: ScoreRound[];
  rounds: { round: number; roundsOfGame: number };
  correctAnswer: string;
}

const ScoreModal: React.FC<ScoreModalProps> = ({
  visible,
  scoreRound,
  rounds,
  correctAnswer,
}) => {
  if (!visible) {
    return null;
  }

  return (
    <View
      style={tw`absolute inset-0 justify-center items-center bg-black bg-opacity-50 pt-20 pb-16 z-50`}
    >
      <Text style={tw`text-xl text-white absolute top-10 font-bold mb-4`}>
        Round {rounds.round} of {rounds.roundsOfGame}
      </Text>

      {correctAnswer !== "" && (
        <View style={tw`mb-3 flex-row items-center bg-green-600/80 px-4 py-2 rounded-full`}>
          <Icon name="check-circle" size={16} color="white" style={tw`mr-2`} />
          <Text style={tw`text-white font-bold`}>It was {correctAnswer}'s photo</Text>
        </View>
      )}

      {scoreRound.map((player, index) => (
        <View key={index} style={tw`w-11/12 max-w-[500px] bg-white mb-2 m-1 rounded-3xl`}>
          <View style={tw`flex-row h-12`}>
            <View style={tw`flex items-center w-[12%] min-w-[40px] justify-center rounded-l-full bg-[#e63a35]`}>
              <Text style={tw`text-lg text-white font-bold`}>{index + 1}</Text>
            </View>
            <View style={tw`flex-row px-2 pr-4 items-center flex-1 justify-between`}>
              <View>
                <Text style={tw`text-lg font-bold`}>{player.username}</Text>
                <View style={tw`flex-row items-center`}>
                  <Icon
                    style={tw`px-2`}
                    name={player.lastAnswerCorrect ? "check-circle" : "times-circle"}
                    size={12}
                    color={player.lastAnswerCorrect ? "green" : "red"}
                  />
                  <Text style={tw`text-xs ${player.lastAnswerCorrect ? "text-green-500" : "text-red-500"}`}>
                    {player.lastGuess || "No guess"}
                  </Text>
                </View>
              </View>
              <Text style={tw`text-lg`}>{player.points}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
};

export default ScoreModal;
