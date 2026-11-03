import React, { useCallback } from "react";
import { View } from "react-native";
import tw from "twrnc";
import { useFocusEffect, useRouter } from "expo-router";
import { useGameContext } from "@/src/providers/GameContext";
import { useRouteBelow } from "@/src/hooks/useRouteBelow";
import { HOME_PATH, HOME_ROUTE_NAME } from "@/src/utils/homeRoute";
import { UNKNOWN_LINK_MESSAGE } from "@/src/utils/serverMessage";

/**
 * A link to a route the app doesn't have (exposeme://i18n/es, a mistyped or old link) opens this screen instead of
 * expo-router's own one, which showed the URL and a list of the app's routes (EXP-412). It gives way at once to the
 * screen under it, as a link to "/" does during a room (EXP-373). That is home in the usual case (the root layout
 * anchors home under a cold-start link), which then tells why in a notice. Over any other screen (the lobby, a game)
 * it says nothing and leaves that screen as it was: a notice left for home would show when the player leaves the room,
 * as if it were the reason.
 */
export default function NotFound() {
  const router = useRouter();
  const routeBelow = useRouteBelow();
  const { setHomeNotice } = useGameContext();

  useFocusEffect(
    useCallback(() => {
      const below = routeBelow();
      if (below === null || below === HOME_ROUTE_NAME) setHomeNotice(UNKNOWN_LINK_MESSAGE);
      // Back pops to the screen under it; replace("/") would stack a second home over it (EXP-339)
      if (below !== null) router.back();
      else router.replace(HOME_PATH);
    }, [])
  );

  // Never seen for more than a frame: dark like the app's screens, not a white flash
  return <View style={tw`flex-1 bg-black`} />;
}
