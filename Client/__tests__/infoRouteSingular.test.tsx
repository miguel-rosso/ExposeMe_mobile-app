import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StackActions, StackRouter } from "expo-router/build/react-navigation/routers/StackRouter";
import { getSingularId } from "expo-router/build/utils/getSingularId";

// EXP-434: a double tap on home's Info link calls router.push("/screens/InfoScreen") twice. The root stack declares the
// Information screen `dangerouslySingular`, so the second push reuses the screen already there instead of stacking a
// second one (which then took two Backs to leave). Checked with the stack router expo-router 58 runs: the screen's
// option is read from the real root layout, and turned into the route id function the way expo-router's useScreens
// does (`true` -> getSingularId); if an upgrade moves these internals, the imports fail loudly.

const INFO_ROUTE = "screens/InfoScreen";
const HOME_ROUTE = "index";

const mockStackProps: { children?: React.ReactNode }[] = [];
jest.mock("expo-router", () => {
  const Stack = (props: { children?: React.ReactNode }) => {
    mockStackProps.push(props);
    return null;
  };
  Stack.Screen = () => null;
  return { Stack };
});
jest.mock("../src/utils/devToolsButton", () => ({ hideDevToolsButton: jest.fn().mockResolvedValue(undefined) }));
jest.mock("expo-font", () => ({ useFonts: () => [true] }));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("expo-screen-orientation", () => ({ lockAsync: jest.fn(), OrientationLock: { PORTRAIT_UP: 1 } }));
jest.mock("expo-device", () => ({ DeviceType: { PHONE: 1 }, getDeviceTypeAsync: jest.fn().mockResolvedValue(1) }));
jest.mock("react-native-reanimated", () => ({}));
jest.mock("@/src/providers/PhotoContext", () => ({ PhotoProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/providers/GameContext", () => ({ GameProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/providers/BackgroundContext", () => ({ BackgroundProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/i18n", () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("../src/components/ErrorScreen", () => ({ AppErrorBoundary: () => null, ScreenErrorBoundary: () => null }));

import RootLayout from "../app/_layout";

type ScreenProps = { name: string; dangerouslySingular?: boolean };
type GetId = (options: { params?: object }) => string | undefined;

/** The props of each Stack.Screen the real root layout declares */
const declaredScreens = async (): Promise<ScreenProps[]> => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RootLayout />);
  });
  act(() => renderer.unmount());
  return React.Children.toArray(mockStackProps.at(-1)?.children)
    .filter(React.isValidElement)
    .map((screen) => screen.props as ScreenProps);
};

/** The route id function expo-router's useScreens gives a screen declared `dangerouslySingular` (true) */
const routeGetIdList = (screens: ScreenProps[]): Record<string, GetId | undefined> =>
  Object.fromEntries(
    screens.map(({ name, dangerouslySingular }) => [
      name,
      dangerouslySingular === true ? (options: { params?: object }) => getSingularId(name, options) : undefined,
    ]),
  );

/** The stack's route names after home pushes the Information screen `pushes` times in a row */
const stackAfterPushes = (getIds: Record<string, GetId | undefined>, pushes: number) => {
  const router = StackRouter({});
  const config = { routeNames: [HOME_ROUTE, INFO_ROUTE], routeParamList: {}, routeGetIdList: getIds };
  // Home alone, as the app starts
  let state: any = {
    type: "stack",
    key: "root-stack",
    stale: false,
    index: 0,
    routeKeySeq: 1,
    routeNames: config.routeNames,
    routes: [{ key: `${HOME_ROUTE}-1`, name: HOME_ROUTE }],
  };
  for (let i = 0; i < pushes; i++) {
    const result: any = router.getStateForAction(state, StackActions.push(INFO_ROUTE), config);
    if (typeof result !== "object") throw new Error(`the stack router did not handle the push (${String(result)})`);
    state = result.state;
  }
  return state.routes.map((route: { name: string }) => route.name);
};

describe("the Information route is singular (EXP-434)", () => {
  it("the root stack declares it dangerouslySingular", async () => {
    const info = (await declaredScreens()).find((screen) => screen.name === INFO_ROUTE);
    expect(info?.dangerouslySingular).toBe(true);
  });

  it("a double tap on home's Info link leaves one Information screen over home", async () => {
    const getIds = routeGetIdList(await declaredScreens());
    expect(stackAfterPushes(getIds, 2)).toEqual([HOME_ROUTE, INFO_ROUTE]);
  });

  it("without it, the same double tap stacks two (what the option prevents)", () => {
    expect(stackAfterPushes({}, 2)).toEqual([HOME_ROUTE, INFO_ROUTE, INFO_ROUTE]);
  });
});
