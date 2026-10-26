import React, { memo } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { playerOptionId } from "@/app/utils/testIds";
import { AnswerOptionsLayout } from "@/app/utils/answerOptionsLayout";

// Answer option cards: compact ones keep a 44 dp touch target (py-3 + a text-sm line) for crowded rooms. Their names
// are cut in the middle: the end stays, so names sharing a long prefix ("Maria_01" / "Maria_02") still differ
const OPTION_CARD = {
  regular: { card: "p-3 mb-2", text: "text-base", ellipsize: "tail" },
  compact: { card: "py-3 px-2 mb-1.5", text: "text-sm", ellipsize: "middle" },
} as const;
const OPTION_BASIS = { 2: "flex-basis-[48%]", 3: "flex-basis-[30%]" } as const;

/** Only MY selection is coloured: blue while answering, then green if it was right, red if wrong (from the reveal) */
export type AnswerOptionState = "idle" | "selected" | "correct" | "wrong";
const OPTION_BG: Record<AnswerOptionState, string> = {
  idle: "bg-gray-700", selected: "bg-blue-500", correct: "bg-green-500", wrong: "bg-red-500",
};

/** How `username`'s option is drawn. The answer is only known from round-reveal on (`correctAnswer`) */
export const answerOptionState = (
  username: string, round: { mySelection: string; correctAnswer: string; isReveal: boolean },
): AnswerOptionState => {
  if (username !== round.mySelection) return "idle";
  if (!round.isReveal) return "selected";
  return username === round.correctAnswer ? "correct" : "wrong";
};

interface AnswerOptionProps {
  username: string;
  state: AnswerOptionState;
  /** My own option: bold, with the "You" tag */
  isMe: boolean;
  youLabel: string;
  columns: AnswerOptionsLayout["columns"];
  compact: boolean;
  disabled: boolean;
  onPick: (username: string) => void;
}

/** One answer option over the photo. Memoised: a pick re-renders only the options whose state changed (EXP-225) */
const AnswerOption = ({ username, state, isMe, youLabel, columns, compact, disabled, onPick }: AnswerOptionProps) => {
  const card = compact ? OPTION_CARD.compact : OPTION_CARD.regular;
  return (
    <TouchableOpacity
      testID={playerOptionId(username)}
      style={tw`${card.card} rounded-lg mx-1 flex-grow ${OPTION_BASIS[columns]} ${OPTION_BG[state]}`}
      onPress={() => onPick(username)}
      disabled={disabled}
    >
      <View style={tw`flex-row items-center justify-between`}>
        <Text style={tw`text-white ${card.text} flex-1 ${isMe ? "font-bold" : ""}`} numberOfLines={1} ellipsizeMode={card.ellipsize}>
          {username}
        </Text>
        <View style={tw`flex-row items-center`}>
          {isMe && <Text style={tw`text-white text-xs bg-gray-600 px-1 py-0.5 rounded-full ml-1`}>{youLabel}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default memo(AnswerOption);
