import React, { memo } from "react";
import { View, Text, ScrollView } from "react-native";
import { EdgeInsets, useSafeAreaInsets } from "react-native-safe-area-context";
import tw from "twrnc";
import { ScoreRound } from "../../models/interfaces";
import Icon from "react-native-vector-icons/FontAwesome";
import { useI18n } from "../../i18n";
import { TEST_IDS, scoreGuessId, scoreMuteId, scoreRankId, scoreRemoveId } from "@/src/utils/testIds";
import { rankScores } from "@/src/utils/ranking";
import { isRevealedOwner } from "@/src/utils/roundState";
import PhotoOwnerCard from "@/src/components/PhotoOwnerCard";
import RemovePlayerButton from "@/src/components/RemovePlayerButton";
import MutePlayerButton from "@/src/components/IngameComunication/MutePlayerButton";
import { MutedNames, NOBODY_MUTED } from "@/src/hooks/useMutedPlayers";
import { useReduceMotion } from "@/src/hooks/useReduceMotion";
import { topClearOfInset } from "@/src/utils/safeAreaRows";
import { HOLD_BUTTON_BOTTOM, HOLD_BUTTON_HEIGHT } from "@/src/utils/gameRows";
import { progressBarAreaBottom, progressBarBand } from "@/src/utils/progressBarRow";

// Layout, in dp (see safeAreaRows)
// Round title from the top edge (pushed down only by a cutout taller than that, to TITLE_INSET_MARGIN below it),
// and the space kept for it above the list
const TITLE_TOP = 40;
const TITLE_INSET_MARGIN = 8;
const TITLE_SPACE = 40;
/** The title's one text-xl line */
const TITLE_LINE_HEIGHT = 28;
// Space kept free under the list, above the bottom inset: the usual margin, or the photo owner's hold button plus a gap
const LIST_BOTTOM_SPACE = 64;
const HOLD_BUTTON_GAP = 16;
export const HOLD_BUTTON_CLEARANCE = HOLD_BUTTON_BOTTOM + HOLD_BUTTON_HEIGHT + HOLD_BUTTON_GAP;
// From this many players on the rows get tighter so more fit before scrolling
const COMPACT_FROM = 7;
// The rows sit on a near-opaque dark panel: the photo (a big caption, busy detail) doesn't show between them (EXP-271)
export const SCORE_LIST_BACKING = "rgba(0,0,0,0.85)";

/**
 * The round title's top: TITLE_TOP, or just below a taller cutout; when that puts it over the round's progress bar
 * (a notch or Dynamic Island), right below the bar's strip instead (EXP-158)
 */
const titleTopFor = (insets: EdgeInsets) => {
  const top = topClearOfInset(insets, TITLE_TOP, TITLE_INSET_MARGIN);
  return top + TITLE_LINE_HEIGHT > progressBarBand(insets).top ? progressBarAreaBottom(insets) : top;
};

interface ScoreModalProps {
  visible: boolean;
  scoreRound: ScoreRound[];
  rounds: { round: number; roundsOfGame: number };
  correctAnswer: string;
  /** This device's player: if the photo was theirs, the card says "It was your photo!" */
  myUsername?: string;
  /** The photo owner's hold button is on screen: keep the list clear of it */
  reserveHoldButton?: boolean;
  /**
   * Host only (EXP-425): the rows of `removable` (the other players still in the room: not one kicked or gone during
   * the scoreboard) get a remove button that asks for them. Keep both stable: the scoreboard is memoised
   */
  onRemovePlayer?: (username: string) => void;
  removable?: ReadonlySet<string>;
  /** Players muted on this device (EXP-422): their rows show it; scores and ranks are unchanged */
  muted?: MutedNames;
  /** Every other player's row gets a mute / unmute button (keep it stable: memo) */
  onToggleMute?: (username: string) => void;
}

const ScoreModal: React.FC<ScoreModalProps> = ({
  visible,
  scoreRound,
  rounds,
  correctAnswer,
  myUsername,
  reserveHoldButton = false,
  onRemovePlayer,
  removable,
  muted = NOBODY_MUTED,
  onToggleMute,
}) => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // Read from the app-wide cache (EXP-315): known on the first frame even when the scoreboard mounts already visible
  // (after a hold is released, or rejoining during scores), so the owner card never bounces in on a stale value
  const reduceMotion = useReduceMotion();

  if (!visible) {
    return null;
  }

  const titleTop = titleTopFor(insets);
  // Where the card and the list may start: below the title and below the round's progress bar. A long list shrinks
  // (and scrolls) down to this edge, so even 12 players with the hold button's space kept never push the card over the
  // bar (EXP-158)
  const contentTop = Math.max(titleTop + TITLE_SPACE, progressBarAreaBottom(insets));
  const ranked = rankScores(scoreRound);
  const compact = ranked.length >= COMPACT_FROM;

  return (
    <View
      testID={TEST_IDS.scoreModal}
      style={[
        tw`absolute inset-0 justify-center items-center bg-black bg-opacity-50 z-50`,
        {
          paddingTop: contentTop,
          paddingBottom: insets.bottom + (reserveHoldButton ? HOLD_BUTTON_CLEARANCE : LIST_BOTTOM_SPACE),
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <Text testID={TEST_IDS.scoreRoundTitle} style={[tw`text-xl text-white absolute font-bold mb-4`, { top: titleTop }]}>
        {t.roundOf.replace("{round}", String(rounds.round)).replace("{total}", String(rounds.roundsOfGame))}
      </Text>

      {correctAnswer !== "" && (
        <PhotoOwnerCard
          owner={correctAnswer}
          isMine={isRevealedOwner(correctAnswer, myUsername)}
          animate={!reduceMotion}
        />
      )}

      {/* Shrinks to the space left (never grows past its rows) and scrolls: 12 players don't fit small phones */}
      <ScrollView
        testID={TEST_IDS.scoreList}
        style={[tw`w-11/12 max-w-[500px] flex-grow-0 rounded-3xl`, { backgroundColor: SCORE_LIST_BACKING }]}
        contentContainerStyle={tw`p-1.5 ${compact ? "gap-1" : "gap-2"}`}
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
              style={tw`bg-white rounded-3xl`}
            >
              <View style={tw`flex-row ${compact ? "h-11" : "h-12"}`}>
                <View style={tw`flex items-center w-[12%] min-w-[40px] justify-center rounded-l-full bg-[#e63a35]`}>
                  <Text testID={scoreRankId(player.username)} style={tw`text-lg text-white font-bold`}>{player.rank}</Text>
                </View>
                <View style={tw`flex-row px-2 pr-4 items-center flex-1 justify-between`}>
                  {/* Shrinks before the points do: long names (up to 15 characters) stay on one line in the fixed-height row */}
                  <View style={tw`flex-shrink mr-2`}>
                    <Text style={tw`text-lg font-bold`} numberOfLines={1} ellipsizeMode="tail">{player.username}</Text>
                    <View style={tw`flex-row items-center`}>
                      <Icon style={tw`px-2`} name={icon} size={12} color={color} />
                      <Text
                        testID={scoreGuessId(player.username)}
                        style={tw`text-xs flex-shrink ${textColor}`}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {label}
                      </Text>
                    </View>
                  </View>
                  <Text style={tw`text-lg`}>{player.points}</Text>
                  {onToggleMute && player.username !== myUsername && (
                    <MutePlayerButton
                      username={player.username}
                      muted={muted.has(player.username)}
                      testID={scoreMuteId(player.username)}
                      onToggle={onToggleMute}
                      onLight
                    />
                  )}
                  {onRemovePlayer && removable?.has(player.username) && (
                    <RemovePlayerButton
                      username={player.username}
                      testID={scoreRemoveId(player.username)}
                      onPress={onRemovePlayer}
                    />
                  )}
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
