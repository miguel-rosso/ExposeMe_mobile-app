import React from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import tw from "twrnc";
import { useI18n } from "@/src/i18n";
import { TEST_IDS } from "@/src/utils/testIds";
import { safeTopRow } from "@/src/utils/safeAreaRows";
import { useServerUnreachable, WatchedSocket } from "@/src/hooks/useServerUnreachable";

/** Its row over the game photo (see safeAreaRows) */
const RECONNECTING_BANNER = { top: 8, margin: 8 } as const;

interface ReconnectingBannerProps {
  /** The game's socket, lost and retrying: the banner is mounted only meanwhile */
  socket: WatchedSocket | null;
}

/**
 * The game's "Reconnecting…" pill, shown while socket.io reconnects; the game screen stays. When the connection
 * doesn't come back (no network, server down or cold-starting) it becomes a message saying so, with Try again
 * (EXP-429): the socket keeps retrying meanwhile, and the game's own Exit stays the way out.
 */
const ReconnectingBanner = ({ socket }: ReconnectingBannerProps) => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { unreachable, retry } = useServerUnreachable(socket, true);

  return (
    <View
      testID={TEST_IDS.reconnectingBanner}
      style={[tw`absolute z-100 items-center`, safeTopRow(insets, RECONNECTING_BANNER.top, RECONNECTING_BANNER.margin)]}
      // The pill lets every tap through; the message only takes its own button's
      pointerEvents={unreachable ? "box-none" : "none"}
    >
      {unreachable ? (
        // Compact (a title and a hint line, the button under them): it covers the top of the game only
        <View
          testID={TEST_IDS.gameServerUnreachable}
          style={tw`w-[92%] max-w-[500px] px-4 py-3 rounded-xl bg-gray-800 bg-opacity-90`}
        >
          <View style={tw`flex-row items-center`}>
            <Ionicons name="cloud-offline-outline" size={20} color="white" />
            <Text accessibilityRole="alert" style={tw`flex-1 text-white text-sm font-bold ml-2`}>
              {t.gameServerUnreachable}
            </Text>
          </View>
          <Text style={tw`text-gray-300 text-xs mt-1`}>{t.gameServerUnreachableHint}</Text>
          <TouchableOpacity
            testID={TEST_IDS.gameServerUnreachableRetry}
            accessibilityRole="button"
            onPress={retry}
            style={tw`bg-blue-600 py-2 rounded-lg mt-2 items-center`}
          >
            <Text style={tw`text-white text-sm font-bold`}>{t.tryAgain}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={tw`text-white text-sm bg-gray-800 bg-opacity-80 px-3 py-1 rounded-full`}>{t.reconnecting}</Text>
      )}
    </View>
  );
};

export default ReconnectingBanner;
