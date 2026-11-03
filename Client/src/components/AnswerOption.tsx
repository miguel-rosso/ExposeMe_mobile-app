import React, { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Text, TouchableOpacity, View } from "react-native";
import * as Haptics from "expo-haptics";
import tw from "twrnc";
import { playerOptionId } from "@/src/utils/testIds";
import { AnswerOptionsLayout } from "@/src/utils/answerOptionsLayout";
import { PLAYER_COLOR_INK, playerInitial } from "@/src/utils/playerColors";

// ── Look ──
// Dark translucent cards (the photo still shows behind them), each with the player's colour and initial. Compact ones
// keep a 44 dp touch target (py-3 + a text-sm line) for crowded rooms. Their names are cut in the middle: the end
// stays, so names sharing a long prefix ("Maria_01" / "Maria_02") still differ. The state badge sticks half out of the
// avatar's corner, so the name keeps a wider gap (`nameGap`) than half a badge
const OPTION_CARD = {
  regular: {
    cell: "mb-2", card: "p-3", text: "text-base", initial: "text-sm", avatar: 28, badge: 15, nameGap: "ml-3", ellipsize: "tail",
  },
  compact: {
    cell: "mb-1.5", card: "py-3 px-2", text: "text-sm", initial: "text-xs", avatar: 20, badge: 13, nameGap: "ml-2.5",
    ellipsize: "middle",
  },
} as const;
// Every card has the same width: an odd one out in the last row is centred by the row, not stretched
const OPTION_BASIS = { 2: "flex-basis-[48%]", 3: "flex-basis-[30%]" } as const;
const OPTION_CELL_MARGIN = { marginHorizontal: "1%" } as const;

/** Only MY selection is marked: accent while answering, then green if it was right, red if wrong (from the reveal) */
export type AnswerOptionState = "idle" | "selected" | "correct" | "wrong";

const ANSWER_ACCENT = "#3b82f6";
const CARD_BORDER_WIDTH = 2;
/** Border of an option in each state (tests read the state from it) */
export const ANSWER_STATE_BORDER: Record<AnswerOptionState, string> = {
  idle: "rgba(255,255,255,0.15)", selected: ANSWER_ACCENT, correct: "#22c55e", wrong: "#ef4444",
};
const STATE_SURFACE: Record<AnswerOptionState, string> = {
  idle: "rgba(0,0,0,0.6)", selected: "rgba(0,0,0,0.6)", correct: "rgba(21,128,61,0.8)", wrong: "rgba(185,28,28,0.8)",
};
// Plain glyphs: no icon font to load while the options mount
const STATE_MARK: Record<AnswerOptionState, string | null> = { idle: null, selected: "✓", correct: "✓", wrong: "✕" };

/** How `username`'s option is drawn. The answer is only known from round-reveal on (`correctAnswer`) */
export const answerOptionState = (
  username: string, round: { mySelection: string; correctAnswer: string; isReveal: boolean },
): AnswerOptionState => {
  if (username !== round.mySelection) return "idle";
  if (!round.isReveal) return "selected";
  return username === round.correctAnswer ? "correct" : "wrong";
};

// ── Motion ── (native driver only: no animation re-renders the option)
/** The cards fade and rise in one after another; the last one has landed within 250 ms */
export const ENTRANCE_MS = 150;
const ENTRANCE_STAGGER_MS = 8;
export const ENTRANCE_MAX_DELAY_MS = 90;
const ENTRANCE_RISE_DP = 8;
export const entranceDelay = (index: number) => Math.min(index * ENTRANCE_STAGGER_MS, ENTRANCE_MAX_DELAY_MS);
/** A marked card stands out slightly; the reveal pops a right pick and shakes a wrong one */
export const MARKED_SCALE = 1.03;
const REVEAL_POP_SCALE = 1.07;
const REVEAL_POP_MS = 100;
const SHAKE_OFFSETS_DP = [-5, 5, -3, 0];
const SHAKE_STEP_MS = 50;
// Pressed cards dim a little (TouchableOpacity's default 0.2 left a tapped card almost invisible over the photo)
const PRESSED_OPACITY = 0.7;

const scaleFor = (state: AnswerOptionState) => (state === "idle" ? 1 : MARKED_SCALE);
const springTo = (value: Animated.Value, toValue: number) =>
  Animated.spring(value, { toValue, speed: 20, bounciness: 10, useNativeDriver: true });
const shake = (offset: Animated.Value) => Animated.sequence(SHAKE_OFFSETS_DP.map((toValue) =>
  Animated.timing(offset, { toValue, duration: SHAKE_STEP_MS, easing: Easing.linear, useNativeDriver: true })));

/** The animation that marks a change of state */
const stateMotion = (state: AnswerOptionState, scale: Animated.Value, offset: Animated.Value) => {
  switch (state) {
    case "correct":
      return Animated.sequence([
        Animated.timing(scale, { toValue: REVEAL_POP_SCALE, duration: REVEAL_POP_MS, useNativeDriver: true }),
        springTo(scale, MARKED_SCALE),
      ]);
    case "wrong":
      return Animated.parallel([springTo(scale, MARKED_SCALE), shake(offset)]);
    default:
      return springTo(scale, scaleFor(state));
  }
};

/** A light tap under the finger when a new pick is made */
const pickFeedback = () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); };

// ── Component ──
interface AnswerOptionProps {
  username: string;
  /** Position in the list: staggers the entrance */
  index: number;
  state: AnswerOptionState;
  /** The player's colour (playerColors) */
  color: string;
  /** My own option: bold, with the "You" tag */
  isMe: boolean;
  youLabel: string;
  columns: AnswerOptionsLayout["columns"];
  compact: boolean;
  disabled: boolean;
  /** False when the system asks to reduce motion: the cards appear and change state without moving */
  animate: boolean;
  onPick: (username: string) => void;
}

/** One answer option over the photo. Memoised: a pick re-renders only the options whose state changed (EXP-225) */
const AnswerOption = ({
  username, index, state, color, isMe, youLabel, columns, compact, disabled, animate, onPick,
}: AnswerOptionProps) => {
  const size = compact ? OPTION_CARD.compact : OPTION_CARD.regular;
  const entrance = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const scale = useRef(new Animated.Value(scaleFor(state))).current;
  const offset = useRef(new Animated.Value(0)).current;
  const shownState = useRef(state);
  // Built once per card: a re-render must not create new native interpolation nodes
  const cellMotion = useMemo(() => ({
    opacity: entrance,
    transform: [
      { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [ENTRANCE_RISE_DP, 0] }) },
      { translateX: offset },
      { scale },
    ],
  }), [entrance, offset, scale]);
  const initial = useMemo(() => playerInitial(username), [username]);

  useEffect(() => {
    if (!animate) return;
    Animated.timing(entrance, {
      toValue: 1, duration: ENTRANCE_MS, delay: entranceDelay(index), easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
    // Only when the card mounts (the voting starts): later renders don't replay it
  }, []);

  useEffect(() => {
    if (shownState.current === state) return;
    shownState.current = state;
    if (animate) stateMotion(state, scale, offset).start();
    else scale.setValue(scaleFor(state));
  }, [state, animate]);

  const onPress = () => {
    if (disabled) return;
    if (state === "idle") pickFeedback();
    onPick(username);
  };

  const mark = STATE_MARK[state];
  // The badge's centre sits on the avatar's square corner, mostly outside the circle: the initial stays readable (EXP-272)
  const badgeOverhang = -size.badge / 2;
  return (
    <Animated.View style={[tw`${size.cell} ${OPTION_BASIS[columns]}`, OPTION_CELL_MARGIN, cellMotion]}>
      <TouchableOpacity
        testID={playerOptionId(username)}
        style={[
          tw`${size.card} rounded-2xl`,
          { borderWidth: CARD_BORDER_WIDTH, borderColor: ANSWER_STATE_BORDER[state], backgroundColor: STATE_SURFACE[state] },
        ]}
        activeOpacity={PRESSED_OPACITY}
        onPress={onPress}
        // Disabled through its accessibility state, which TouchableOpacity also honours for touches and the press dim
        // (and no focus, as its `disabled` prop gave): that prop would start a no-op opacity animation on every card
        // each time the answers close, making every card's touch layer native-driven (EXP-265)
        focusable={!disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: state !== "idle", disabled }}
      >
        <View style={tw`flex-row items-center`}>
          <View
            style={[
              tw`items-center justify-center rounded-full`,
              { width: size.avatar, height: size.avatar, backgroundColor: color },
            ]}
          >
            {/* No Android font padding: the glyph sits in the avatar's centre instead of drifting down towards the badge */}
            <Text style={[tw`${size.initial} font-bold`, { color: PLAYER_COLOR_INK, includeFontPadding: false }]}>{initial}</Text>
            {mark && (
              <View
                style={[
                  tw`absolute items-center justify-center rounded-full border border-black`,
                  {
                    width: size.badge, height: size.badge, right: badgeOverhang, bottom: badgeOverhang,
                    backgroundColor: ANSWER_STATE_BORDER[state],
                  },
                ]}
              >
                <Text style={[tw`text-white font-bold`, { fontSize: size.badge - 5, lineHeight: size.badge - 2 }]}>{mark}</Text>
              </View>
            )}
          </View>
          <Text
            style={tw`text-white ${size.text} flex-1 ${size.nameGap} ${isMe ? "font-bold" : ""}`}
            numberOfLines={1}
            ellipsizeMode={size.ellipsize}
          >
            {username}
          </Text>
          {isMe && (
            <Text style={[tw`text-white text-xs font-semibold px-1.5 py-0.5 rounded-full overflow-hidden ml-1`, { backgroundColor: ANSWER_ACCENT }]}>
              {youLabel}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

export default memo(AnswerOption);
