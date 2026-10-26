import React from "react";
import { View } from "react-native";
import tw from "twrnc";
import EmojiReaction from "./EmojiReaction";

export interface EmojiReactionData { id: string; username: string; emoji: string }

// Breathing room between the lane and the answer buttons below it
export const REACTION_LANE_GAP = 8;
// Vertical space one reaction pill takes in the stack: text-2xl line (32) + py-1 (8) + mb-2 (8)
export const REACTION_PILL_HEIGHT = 48;

interface EmojiReactionLaneProps {
  reactions: EmojiReactionData[];
  // Lane start (px from the top of the game screen): just below the round progress bar
  top: number;
  // Top edge of the answer buttons, once measured: the lane stops above it and clips the oldest reactions
  answersTop: number | null;
  screenshotLabel: string;
  onReactionEnd: (id: string) => void;
}

// Room reactions in their own strip over the photo, between the progress bar and the answer buttons, so they never
// cover either. Newest first: when the strip is short, the oldest reactions are the ones left out.
const EmojiReactionLane: React.FC<EmojiReactionLaneProps> = ({ reactions, top, answersTop, screenshotLabel, onReactionEnd }) => {
  const maxHeight = answersTop === null ? undefined : Math.max(0, answersTop - top - REACTION_LANE_GAP);
  // Only whole pills, never one cut in half; when not even one fits (landscape, many players) none is shown
  const fitting = maxHeight === undefined ? reactions.length : Math.floor(maxHeight / REACTION_PILL_HEIGHT);
  const newestFirst = [...reactions].reverse().slice(0, fitting);

  return (
    <View pointerEvents="none" style={[tw`absolute left-4 right-4 z-90 items-start overflow-hidden`, { top, maxHeight }]}>
      {newestFirst.map((r) => (
        <EmojiReaction
          key={r.id}
          username={r.username}
          emoji={r.emoji}
          screenshotLabel={screenshotLabel}
          onAnimationEnd={() => onReactionEnd(r.id)}
        />
      ))}
    </View>
  );
};

export default EmojiReactionLane;
