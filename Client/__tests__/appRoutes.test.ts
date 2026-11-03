import fs from "fs";
import path from "path";
import { requireContext } from "expo-router/build/testing-library/context-stubs";
import { getRoutes } from "expo-router/build/getRoutes";
import { getLinkingConfig } from "expo-router/build/getLinkingConfig";

// EXP-054: expo-router turns every module under app/ into a route. Components, providers, hooks, utils and the i18n
// tables used to live there too, so Metro warned about each one ("missing the required default export") and a link
// like exposeme://i18n/es opened the translations object as a screen. app/ now holds only the screens the root Stack
// declares (plus layouts); the rest of the app's code is in src/. These checks fail if a non-screen module creeps back.
// Same expo-router 58 internals as rootLayoutAnchor.test (renderRouter needs @testing-library/react-native, which the
// project does not install): the router's own file filter and route builder read the real app/ directory, and the
// routes are only listed, never loaded.

const { EXPO_ROUTER_CTX_IGNORE } = require("expo-router/_ctx-shared") as { EXPO_ROUTER_CTX_IGNORE: RegExp };

const APP_DIR = path.join(__dirname, "..", "app");
const ROOT_LAYOUT_FILE = path.join(APP_DIR, "_layout.tsx");
const STACK_SCREEN_NAME_RE = /<Stack\.Screen\s+name="([^"]+)"/g;
const DEFAULT_EXPORT_RE = /^export default /m;
const NOT_FOUND_ROUTE = "+not-found";

type NavigationState = { index?: number; routes: { name: string; state?: NavigationState }[] };

const appContext = () => requireContext(APP_DIR, true, EXPO_ROUTER_CTX_IGNORE);
const appRoutes = () => getRoutes(appContext(), { internal_stripLoadRoute: true, platform: "ios" })!;

/** The routes built from files under app/ (not the ones expo-router generates, like its not-found screen) */
const fileRoutes = () => appRoutes().children.filter((route) => !route.generated);

const screensDeclaredByRootStack = () =>
  [...fs.readFileSync(ROOT_LAYOUT_FILE, "utf8").matchAll(STACK_SCREEN_NAME_RE)].map(([, name]) => name);

/** The screen expo-router shows when the app is opened at `url` (e.g. from an exposeme:// link) */
const screenOpenedAt = (url: string) => {
  const linking = getLinkingConfig(appRoutes(), appContext(), {
    metaOnly: false,
    skipGenerated: false,
    sitemap: true,
    notFound: true,
  });
  let state = linking.getStateFromPath(url, linking.config) as NavigationState | undefined;
  let name: string | undefined;
  while (state) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    name = route.name;
    state = route.state;
  }
  return name;
};

describe("app/ holds only routes (EXP-054)", () => {
  it("every route under app/ is a screen the root Stack declares", () => {
    const routes = fileRoutes().map((route) => route.route).sort();
    expect(routes).toEqual([...screensDeclaredByRootStack()].sort());
  });

  it("every route file under app/ exports its screen as default", () => {
    const withoutDefault = fileRoutes()
      .map((route) => route.contextKey)
      .filter((key) => !DEFAULT_EXPORT_RE.test(fs.readFileSync(path.join(APP_DIR, key), "utf8")));
    expect(withoutDefault).toEqual([]);
  });

  it.each(["/i18n/es", "/components/modals/AlertModal", "/providers/PhotoContext", "/utils/image"])(
    "a link to %s opens the not-found screen, not a module as a screen",
    (url) => {
      expect(screenOpenedAt(url)).toBe(NOT_FOUND_ROUTE);
    },
  );

  it("a link to a screen still opens it", () => {
    expect(screenOpenedAt("/screens/WaitingRoom")).toBe("screens/WaitingRoom");
  });
});
