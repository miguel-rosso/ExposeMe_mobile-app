// expo-router's navigation hooks (useNavigation().getState(), useRoute()) for a screen rendered alone, as the top route
// of the root stack over `routesBelow` (route names, bottom first; home alone by default). Spread it into a test's own
// expo-router mock: `...require("../testUtils/screenNavigation").screenNavigationMock()`. For a whole stack of mounted
// screens use stackRouter.tsx instead.

const SCREEN_ROUTE_KEY = "screen-under-test";
const HOME_ROUTE_NAME = "index";

export const screenNavigationMock = (routesBelow: () => readonly string[] = () => [HOME_ROUTE_NAME]) => ({
  useNavigation: () => ({
    getState: () => ({
      routes: [
        ...routesBelow().map((name, i) => ({ key: `below-${i}`, name })),
        { key: SCREEN_ROUTE_KEY, name: "screen-under-test" },
      ],
    }),
  }),
  useRoute: () => ({ key: SCREEN_ROUTE_KEY }),
});
