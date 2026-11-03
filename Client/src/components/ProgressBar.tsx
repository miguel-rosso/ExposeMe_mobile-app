import React, { useEffect, useRef } from "react";
import { View, Animated } from "react-native";
import tw from "twrnc";

interface ProgressBarProps {
  /** What is left of the phase, in ms: the bar fills up in exactly that time */
  duration: number;
  /** Fraction of the phase already gone when the bar mounts (a resumed phase): it starts that full. 0 by default */
  elapsed?: number;
  /**
   * Device time (Date.now()) the server event that started the phase arrived: the bar fills up at `startedAt + duration`
   * however late it mounts, so a slow paint never stretches the phase (EXP-300). Its own first render by default
   */
  startedAt?: number;
  /** Called once when the bar fills up (not when it is unmounted or restarted first) */
  onEnd?: () => void;
}

// The fill is full width, scaled horizontally from its left edge: a transform runs on the native driver, so the bar
// costs no JS work (nor commits) per frame while the round's phases render (EXP-175, EXP-225)
const FILL_FROM_LEFT = { transformOrigin: "left" } as const;

const clampFraction = (fraction: number) => Math.min(1, Math.max(0, fraction));

// A mount that took at least this long after the bar's render moves the bar to where it is when its animation starts.
// Moving it costs one more commit (EXP-225), so a quicker mount keeps its render-time start: at most this far behind,
// its fill runs imperceptibly fast and still ends on time.
const MOUNT_GAP_TO_RESYNC_MS = 100;

/** How full the bar is `late` ms after the phase's start: `elapsed` at the start, full `duration` ms later */
const fillAfter = (late: number, duration: number, elapsed: number) => {
  const start = clampFraction(elapsed);
  return duration > 0 ? clampFraction(start + ((1 - start) * Math.max(0, late)) / duration) : start;
};

const ProgressBar: React.FC<ProgressBarProps> = ({ duration, elapsed = 0, startedAt, onEnd }) => {
  const renderedAt = useRef(Date.now()).current;
  const phaseStart = startedAt ?? renderedAt;
  const progress = useRef(new Animated.Value(fillAfter(renderedAt - phaseStart, duration, elapsed))).current;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;

  useEffect(() => {
    // A slow mount can take hundreds of ms between the render and this effect: the fill starts from where the bar is
    // now, and runs for what is left now. Mounted after the phase's time ran out, it is full and ends at once
    const now = Date.now();
    const late = now - phaseStart;
    if (now - renderedAt >= MOUNT_GAP_TO_RESYNC_MS) progress.setValue(fillAfter(late, duration, elapsed));
    const timeLeft = Math.max(0, duration - late);
    Animated.timing(progress, {
      toValue: 1,
      duration: timeLeft,
      useNativeDriver: true,
    }).start(({ finished }) => { if (finished) onEndRef.current?.(); });
  }, [duration]);

  return (
    <View style={tw`h-2 bg-gray-300 rounded-full overflow-hidden`}>
      <Animated.View style={[tw`h-full w-full bg-green-500`, FILL_FROM_LEFT, { transform: [{ scaleX: progress }] }]} />
    </View>
  );
};

export default ProgressBar;
