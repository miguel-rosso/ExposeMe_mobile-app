import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import tw from "twrnc";
import { useI18n } from "../../i18n";
import { TEST_IDS } from "@/app/utils/testIds";
import { formatCountdown } from "@/app/utils/gameState";

interface PausedModalProps {
  /** When the server's pause countdown ends (local clock: receipt time + the server's duration), or null */
  endsAt: number | null;
}

/**
 * Shown to every connected player while the server has the game paused (fewer than 2 connected).
 * Only displays the server's countdown: when it runs out the server sends game-over.
 */
const PausedModal: React.FC<PausedModalProps> = ({ endsAt }) => {
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
        <Text style={tw`text-lg text-white text-center mb-4`}>{t.waitingPlayersReturn}</Text>
        <Text testID={TEST_IDS.pausedCountdown} style={tw`text-4xl text-white font-bold`}>
          {formatCountdown(remaining)}
        </Text>
      </View>
    </View>
  );
};

export default PausedModal;
