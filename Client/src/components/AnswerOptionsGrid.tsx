import React, { memo, useRef } from "react";
import { ScrollView, type ScrollViewInstance, View } from "react-native";
import tw from "twrnc";
import { Player } from "@/src/models/interfaces";
import { AnswerOptionsLayout } from "@/src/utils/answerOptionsLayout";
import { TEST_IDS } from "@/src/utils/testIds";

// Rows centre their cards; room on top for a picked card's scale
const GRID_ROW = tw`flex-row justify-center`;
const GRID_CONTENT = tw`w-full pt-1`;

/** The players in rows of `columns`, in order (the last row may be shorter) */
const answerGridRows = (players: readonly Player[], columns: number): Player[][] => {
  const rows: Player[][] = [];
  for (let start = 0; start < players.length; start += columns) rows.push(players.slice(start, start + columns));
  return rows;
};

interface AnswerOptionsGridProps {
  players: readonly Player[];
  layout: AnswerOptionsLayout;
  /** One player's option (an AnswerOption); `index` is the player's position in the list */
  renderOption: (player: Player, index: number) => React.ReactElement;
}

/**
 * The answer options over the photo, `layout.columns` per row, in an area capped to `layout.maxHeight` that scrolls.
 * A plain scroll view (EXP-265): with at most 12 options a virtualised list only added its own cells, per-cell layout
 * events and batched re-renders to every round's mount, and on Android the clipping of off-screen subviews.
 */
const AnswerOptionsGrid = ({ players, layout, renderOption }: AnswerOptionsGridProps) => {
  const scrollRef = useRef<ScrollViewInstance>(null);
  // iOS only draws the scroll indicator while scrolling: flash it when some options are out of view
  const hintMoreOptions = (_width: number, contentHeight: number) => {
    if (contentHeight > layout.maxHeight) scrollRef.current?.flashScrollIndicators();
  };

  return (
    <ScrollView
      ref={scrollRef}
      testID={TEST_IDS.answerOptions}
      style={[tw`w-full max-w-[500px] px-2`, { maxHeight: layout.maxHeight }]}
      contentContainerStyle={GRID_CONTENT}
      showsVerticalScrollIndicator
      persistentScrollbar
      indicatorStyle="white"
      onContentSizeChange={hintMoreOptions}
    >
      {answerGridRows(players, layout.columns).map((row, rowIndex) => (
        <View key={rowIndex} style={GRID_ROW}>
          {row.map((player, column) => (
            <React.Fragment key={player.username}>{renderOption(player, rowIndex * layout.columns + column)}</React.Fragment>
          ))}
        </View>
      ))}
    </ScrollView>
  );
};

export default memo(AnswerOptionsGrid);
