import { useNavigation, useRoute } from "expo-router";

/** What this needs from a navigator's state: its routes, bottom to top. */
interface StackState {
  routes: readonly { key: string; name: string }[];
}

/** Name of the route right under the route `key` in `state`, or null (it is the bottom one, or not in that stack). */
export const routeNameBelow = (state: StackState | undefined, key: string): string | null => {
  const routes = state?.routes ?? [];
  const index = routes.findIndex((route) => route.key === key);
  return index > 0 ? routes[index - 1].name : null;
};

/**
 * Reads, when called, the name of the screen under this one in its stack (e.g. "screens/GameScreen"), or null. A
 * function, so an effect gets the stack as it is when it runs.
 */
export const useRouteBelow = (): (() => string | null) => {
  const navigation = useNavigation();
  const { key } = useRoute();
  return () => routeNameBelow(navigation.getState(), key);
};

export default useRouteBelow;
