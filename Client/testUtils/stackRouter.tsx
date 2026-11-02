import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";

// A stand-in for expo-router's root stack that keeps every screen of the stack mounted, like the native stack: the
// screens under the top one keep their state and effects, only the top one is focused. Its router acts like
// expo-router's: replace, back and dismiss act on the top screen (whichever screen calls them), and an invite deep
// link updates the top screen's params when it is that route, or pushes it. Mock expo-router with
// `jest.mock("expo-router", () => require("../testUtils/stackRouter").expoRouterMock)`.

type Params = Record<string, string | undefined>;
type Href = string | { pathname: string; params?: Params };
export interface StackEntry {
  key: number;
  path: string;
  params: Params;
}

const HOME_PATH = "/";
let nextKey = 0;
let stack: StackEntry[] = [];
const listeners = new Set<() => void>();
const setStack = (next: StackEntry[]) => {
  stack = next;
  listeners.forEach((l) => l());
};
const entryOf = (href: Href): StackEntry => {
  const { pathname, params } = typeof href === "string" ? { pathname: href, params: {} } : href;
  return { key: ++nextKey, path: pathname, params: params ?? {} };
};
const withTop = (top: StackEntry) => [...stack.slice(0, -1), top];

/** Every router call, in order, e.g. "push /screens/WaitingRoom". */
export const routerCalls: string[] = [];
const describeHref = (href: Href) => (typeof href === "string" ? href : href.pathname);

export const stackRouter = {
  push: (href: Href) => {
    routerCalls.push(`push ${describeHref(href)}`);
    setStack([...stack, entryOf(href)]);
  },
  replace: (href: Href) => {
    routerCalls.push(`replace ${describeHref(href)}`);
    setStack(withTop(entryOf(href)));
  },
  back: () => {
    routerCalls.push("back");
    setStack(stack.slice(0, -1));
  },
  dismiss: () => {
    routerCalls.push("dismiss");
    setStack(stack.slice(0, -1));
  },
  // Like react-navigation's POP_TO: the screen it pops to takes the href's params (none for a bare path)
  dismissTo: (href: Href) => {
    routerCalls.push(`dismissTo ${describeHref(href)}`);
    const target = entryOf(href);
    const index = stack.map((e) => e.path).lastIndexOf(target.path);
    setStack(index >= 0 ? [...stack.slice(0, index), { ...stack[index], params: target.params }] : withTop(target));
  },
  setParams: (params: Params) => {
    routerCalls.push("setParams");
    const top = stack[stack.length - 1];
    setStack(withTop({ ...top, params: { ...top.params, ...params } }));
  },
};

/** Resets the stack to home alone. */
export const resetStack = () => {
  routerCalls.length = 0;
  setStack([entryOf(HOME_PATH)]);
};

/** The stack's routes, bottom to top. */
export const stackPaths = () => stack.map((e) => e.path);

/** An invite deep link to `path` with `params`, as expo-router's NAVIGATE: the top screen's params, or a push. */
export const openDeepLink = (path: string, params: Params) => {
  const top = stack[stack.length - 1];
  if (top?.path === path) setStack(withTop({ ...top, params }));
  else setStack([...stack, entryOf({ pathname: path, params })]);
};

// ── Screens ──

interface ScreenState {
  /** The route's key in the navigation state */
  routeKey: string;
  params: Params;
  focused: boolean;
}
const ScreenContext = createContext<ScreenState>({ routeKey: "", params: {}, focused: true });

/** A path's route name in the root stack, like expo-router's: "/" is "index", "/screens/X" is "screens/X". */
const routeNameOf = (path: string) => (path === HOME_PATH ? "index" : path.replace(/^\//, ""));
const routeKeyOf = (entry: StackEntry) => String(entry.key);

/** The stack's navigation state, as the navigation object's getState() returns it (routes bottom to top). */
const navigationState = () => ({
  index: stack.length - 1,
  routes: stack.map((entry) => ({ key: routeKeyOf(entry), name: routeNameOf(entry.path), params: entry.params })),
});

/** Every screen of the stack, mounted at once; `screens` maps a route path to its component. */
export const StackScreens = ({ screens }: { screens: Record<string, React.ComponentType> }) => {
  const entries = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => stack,
  );
  return (
    <>
      {entries.map((entry, i) => {
        const Screen = screens[entry.path];
        return (
          <ScreenContext.Provider
            key={entry.key}
            value={{ routeKey: routeKeyOf(entry), params: entry.params, focused: i === entries.length - 1 }}
          >
            {Screen ? <Screen /> : null}
          </ScreenContext.Provider>
        );
      })}
    </>
  );
};

const useFocusEffect = (effect: () => void | (() => void)) => {
  const { focused } = useContext(ScreenContext);
  useEffect(() => (focused ? effect() : undefined), [focused, effect]);
};

export const expoRouterMock = {
  useRouter: () => stackRouter,
  useLocalSearchParams: () => useContext(ScreenContext).params,
  useFocusEffect,
  useNavigation: () => ({ getState: navigationState }),
  useRoute: () => ({ key: useContext(ScreenContext).routeKey }),
};
