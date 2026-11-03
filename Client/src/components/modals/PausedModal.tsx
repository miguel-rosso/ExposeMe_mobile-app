import React, { useEffect, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import tw from "twrnc";
import { useI18n } from "../../i18n";
import { TEST_IDS } from "@/src/utils/testIds";
import { formatCountdown } from "@/src/utils/gameState";
import { waitingForText } from "@/src/utils/waitingFor";
import { fillTemplate } from "@/src/i18n/format";

// Safety cap for the "Waiting for …" line (names are at most 15 characters, so three of them fit in fewer lines)
const WAITING_FOR_MAX_LINES = 4;

interface PausedModalProps {
  /** When the server's pause countdown ends (local clock: receipt time + the server's duration), or null */
  endsAt: number | null;
  /** Which pause this is (1..maxPauses): on the last one the game ends if nobody comes back */
  pause: number;
  maxPauses: number;
  /** Players the server is waiting for (game-paused `waitingFor`, updated while paused) */
  waitingFor: readonly string[];
  /** Exit: asks whether to leave the game (the game screen's LeaveGameConfirm) */
  onLeave: () => void;
}

/**
 * Shown to every connected player while the server has the game paused (fewer than 2 connected).
 * Only displays who the server waits for (EXP-380), its countdown (when it runs out the server sends game-over) and
 * "pause N of M", with an Exit for whoever doesn't want to wait (EXP-377).
 */
const PausedModal: React.FC<PausedModalProps> = ({ endsAt, pause, maxPauses, waitingFor, onLeave }) => {
  const { t } = useI18n();
  const [remaining, setRemaining] = useState(endsAt === null ? 0 : endsAt - Date.now());

  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => setRemaining(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  if (endsAt === null) return null;

  return (
    <View
      testID={TEST_IDS.pausedModal}
      style={tw`absolute top-0 left-0 right-0 bottom-0 z-90 justify-center items-center bg-black bg-opacity-70`}
    >
      <View style={tw`rounded-lg p-6 bg-gray-800 w-4/5 max-w-[500px] items-center`}>
        <Text style={tw`text-2xl text-white font-bold text-center mb-3`}>{t.gamePaused}</Text>
        <Text
          testID={TEST_IDS.pausedWaitingFor}
          numberOfLines={WAITING_FOR_MAX_LINES}
          ellipsizeMode="tail"
          style={tw`text-lg text-white text-center mb-4`}
        >
          {waitingForText(waitingFor, t)}
        </Text>
        <Text testID={TEST_IDS.pausedCountdown} style={tw`text-4xl text-white font-bold`}>
          {formatCountdown(remaining)}
        </Text>
        {maxPauses > 0 && (
          <Text testID={TEST_IDS.pausedCounter} style={tw`text-base text-gray-300 text-center mt-4`}>
            {fillTemplate(t.pauseOf, { pause: String(pause), max: String(maxPauses) })}
          </Text>
        )}
        {maxPauses > 0 && pause >= maxPauses && (
          <Text testID={TEST_IDS.pausedLastWarning} style={tw`text-base text-yellow-300 font-bold text-center mt-2`}>
            {t.lastPauseWarning}
          </Text>
        )}
        <TouchableOpacity
          testID={TEST_IDS.pausedLeaveButton}
          accessibilityRole="button"
          onPress={onLeave}
          style={tw`mt-6 px-5 py-2 rounded-lg bg-gray-600`}
        >
          <Text style={tw`text-white text-base font-semibold`}>{t.leaveGame}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default PausedModal;
