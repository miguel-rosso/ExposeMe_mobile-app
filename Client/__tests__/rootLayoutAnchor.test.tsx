import { inMemoryContext } from "expo-router/build/testing-library/context-stubs";
import { getRoutes } from "expo-router/build/getRoutes";
import { createSeededNavigationState } from "expo-router/build/global-state/createSeededNavigationState";
import { ROOT_CHAIN } from "expo-router/build/react-navigation/routers/stateKeys";

// EXP-334: an invite link that cold-starts the app (exposeme://screens/WaitingRoom?code=…) must open the waiting room
// on top of home, so Back and dismissTo("/") reach home instead of closing the app. expo-router puts the layout's
// `unstable_settings.anchor` under a deep-linked route when it builds the stack for that link.
// Why internals and not the public `renderRouter` (expo-router/testing-library) with an initialUrl: it needs the
// optional peer dependency @testing-library/react-native, which this project does not install (its import fails at
// load). So this builds the stack with the same expo-router 58 functions that seed the navigation state from a link
// (build/getRoutes, build/global-state/createSeededNavigationState); if an upgrade moves them, the import fails
// loudly rather than the check passing silently. Switch to renderRouter if that library is ever added.

jest.mock("../src/utils/devToolsButton", () => ({ hideDevToolsButton: jest.fn().mockResolvedValue(undefined) }));
jest.mock("expo-font", () => ({ useFonts: () => [false] }));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("expo-screen-orientation", () => ({ lockAsync: jest.fn(), OrientationLock: { PORTRAIT_UP: 1 } }));
jest.mock("expo-device", () => ({ DeviceType: { PHONE: 1 }, getDeviceTypeAsync: jest.fn().mockResolvedValue(1) }));
jest.mock("react-native-reanimated", () => ({}));
jest.mock("@/src/providers/PhotoContext", () => ({ PhotoProvider: () => null }));
jest.mock("../src/providers/GameContext", () => ({ GameProvider: () => null }));
jest.mock("../src/providers/BackgroundContext", () => ({ BackgroundProvider: () => null }));
jest.mock("../src/i18n", () => ({ I18nProvider: () => null }));

import RootLayout, { unstable_settings } from "../app/_layout";

const Screen = () => null;
/** The app's route tree with its real root layout (and its settings), screens stubbed */
const appRoutes = () =>
  getRoutes(
    inMemoryContext({
      _layout: { default: RootLayout, unstable_settings },
      index: Screen,
      "screens/WaitingRoom": Screen,
      "screens/GameScreen": Screen,
    }),
    { internal_stripLoadRoute: false, ignoreEntryPoints: true } as any,
  )!;

/** The stack expo-router builds when the app is opened at `routes` (e.g. from a link). */
const stackOpenedAt = (routes: { name: string; params?: object }[]) => {
  const state = createSeededNavigationState({ routes } as any, appRoutes(), ROOT_CHAIN);
  return { names: state.routes.map((r: { name: string }) => r.name), focused: state.routes[state.index]?.name };
};

describe("root stack anchor (EXP-334)", () => {
  it("a cold invite link opens the waiting room on top of home", () => {
    expect(stackOpenedAt([{ name: "screens/WaitingRoom", params: { code: "ABC234" } }])).toEqual({
      names: ["index", "screens/WaitingRoom"],
      focused: "screens/WaitingRoom",
    });
  });

  it("a normal launch is home alone", () => {
    expect(stackOpenedAt([{ name: "index" }])).toEqual({ names: ["index"], focused: "index" });
  });
});
