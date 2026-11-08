// expo-router's navigation hooks (useNavigation().getState(), useRoute(), the focus hooks) for a screen rendered alone,
// as the focused top route `screenName` of the root stack over `routesBelow` (route names, bottom first; home alone by
// default). Spread it into a test's own expo-router mock: `...require("../testUtils/screenNavigation").screenNavigationMock()`.
// For a whole stack of mounted screens use stackRouter.tsx instead.
import { useEffect } from "react";

const SCREEN_ROUTE_KEY = "screen-under-test";
const SCREEN_ROUTE_NAME = "screen-under-test";
const HOME_ROUTE_NAME = "index";

export const screenNavigationMock = (
  routesBelow: () => readonly string[] = () => [HOME_ROUTE_NAME],
  screenName: string = SCREEN_ROUTE_NAME,
) => ({
  useNavigation: () => ({
    getState: () => ({
      routes: [
        ...routesBelow().map((name, i) => ({ key: `below-${i}`, name })),
        { key: SCREEN_ROUTE_KEY, name: screenName },
      ],
    }),
  }),
  useRoute: () => ({ key: SCREEN_ROUTE_KEY, name: screenName }),
  // The screen stays focused: a focus effect runs like a plain effect
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  useIsFocused: () => true,
});
