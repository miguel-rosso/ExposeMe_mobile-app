import React, { Profiler } from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Image } from "react-native";

// EXP-397: the native stack keeps home mounted under the lobby and the game screen. The rotating background lived in
// the provider's state, so home re-rendered whole every 10 s during the entire game. Now only a focused screen follows
// the background (a covered one catches up once back on top), and it only rotates while a focused screen shows it.
// Real home and BackgroundProvider in a native-like stack; the lobby is a stand-in that draws the background too.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "acceptedTermsVersion" ? require("../src/utils/termsAcceptance").TERMS_VERSION : k === "username" ? "ana" : null));
  return mock;
});
jest.mock("expo-router", () => require("../testUtils/stackRouter").expoRouterMock);
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: () => null }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({ useGalleryAccessGuard: () => ({ check: jest.fn() }) }));
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
// Plain views: the entrance animations' own renders would count as home's
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
// A game context that never changes: home's re-renders here come from the background alone
jest.mock("../src/providers/GameContext", () => {
  const game = {
    username: "ana", saveUsername: jest.fn(), gameCode: null, setGameCode: jest.fn(), joinCodeDraft: "", setJoinCodeDraft: jest.fn(),
    socket: null, endSocket: jest.fn(), requestNewRoom: jest.fn(), takeHomeNotice: () => null, takeRoomExit: () => null,
  };
  return { useGameContext: () => game };
});

import Index from "../app/index";
import { BACKGROUND_ROTATION_MS, BackgroundProvider, useBackgroundContext } from "../src/providers/BackgroundContext";
import { backgrounds } from "../src/providers/BackgroundContextInstance";
import { resetStack, stackRouter, StackScreens } from "../testUtils/stackRouter";

const HOME = "/";
const LOBBY = "/screens/WaitingRoom";
const GAME = "/screens/GameScreen";
const LOBBY_BACKGROUND_ID = "lobby-background";
const THIRTY_SECONDS_MS = 30_000;

let homeRenders = 0;
const countHomeRender = () => { homeRenders += 1; };
const Home = () => (
  <Profiler id="home" onRender={countHomeRender}>
    <Index />
  </Profiler>
);
/** Every background the lobby rendered with, in order */
let lobbyRenders: number[] = [];
const Lobby = () => {
  const { backgroundImage } = useBackgroundContext();
  lobbyRenders.push(backgroundImage);
  return <Image testID={LOBBY_BACKGROUND_ID} source={backgroundImage} />;
};
// The game screen draws no background
const Game = () => null;

let app: TestRenderer.ReactTestRenderer | null = null;
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const showHome = async () => {
  resetStack();
  await act(async () => {
    app = TestRenderer.create(
      <BackgroundProvider>
        <StackScreens screens={{ [HOME]: Home, [LOBBY]: Lobby, [GAME]: Game }} />
      </BackgroundProvider>
    );
  });
  await flush();
  return app!.root;
};
const navigate = async (go: () => void) => {
  act(go);
  await flush();
};
/** Lets `ms` go by one rotation at a time, so each new background is committed on its own, as on a device */
const wait = (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += BACKGROUND_ROTATION_MS) {
    act(() => { jest.advanceTimersByTime(Math.min(BACKGROUND_ROTATION_MS, ms - elapsed)); });
  }
};

const homeBackground = (root: ReactTestInstance) =>
  root.find((n) => typeof n.type === "string" && n.props.blurRadius !== undefined).props.source;
const lobbyBackground = (root: ReactTestInstance) =>
  root.find((n) => typeof n.type === "string" && n.props.testID === LOBBY_BACKGROUND_ID).props.source;
const distinct = (images: number[]) => images.filter((image, i) => i === 0 || image !== images[i - 1]);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  homeRenders = 0;
  lobbyRenders = [];
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Rotating background on covered screens (EXP-397)", () => {
  it("on top, home moves to a new background", async () => {
    const root = await showHome();
    const first = homeBackground(root);
    wait(BACKGROUND_ROTATION_MS);
    expect(homeBackground(root)).not.toBe(first);
  });

  it("each rotation shows a different background, all of them before one repeats", async () => {
    const root = await showHome();
    const shown = [homeBackground(root)];
    for (let i = 1; i < 2 * backgrounds.length; i++) {
      wait(BACKGROUND_ROTATION_MS);
      shown.push(homeBackground(root));
    }
    expect(distinct(shown)).toHaveLength(shown.length);
    // The first round shows all of them; the next one the other five, never starting on the one on screen
    const firstRound = shown.slice(0, backgrounds.length);
    const secondRound = shown.slice(backgrounds.length, 2 * backgrounds.length - 1);
    expect(new Set(firstRound).size).toBe(backgrounds.length);
    expect(new Set(secondRound).size).toBe(backgrounds.length - 1);
    expect(secondRound).not.toContain(firstRound[firstRound.length - 1]);
  });

  it("under the lobby, home doesn't re-render for 30 s while the lobby's background keeps rotating", async () => {
    await showHome();
    await navigate(() => stackRouter.push(LOBBY));
    homeRenders = 0;
    lobbyRenders = [];

    wait(THIRTY_SECONDS_MS);
    expect(homeRenders).toBe(0);
    expect(distinct(lobbyRenders)).toHaveLength(3); // the lobby, on top, moved on with each rotation
  });

  it("with the game on top no screen shows it: the background stays still, and rotates again once the lobby is back", async () => {
    const root = await showHome();
    await navigate(() => stackRouter.push(LOBBY));
    await navigate(() => stackRouter.push(GAME));
    const underTheGame = lobbyBackground(root);
    homeRenders = 0;
    lobbyRenders = [];

    wait(THIRTY_SECONDS_MS);
    expect(homeRenders).toBe(0);
    expect(lobbyRenders).toHaveLength(0);

    await navigate(() => stackRouter.back());
    expect(lobbyBackground(root)).toBe(underTheGame);
    wait(BACKGROUND_ROTATION_MS);
    expect(lobbyBackground(root)).not.toBe(underTheGame);
  });

  it("back on top, home shows the background the lobby left, and goes on rotating", async () => {
    const root = await showHome();
    await navigate(() => stackRouter.push(LOBBY));
    wait(THIRTY_SECONDS_MS);
    const lobbyLeft = lobbyBackground(root);

    await navigate(() => stackRouter.back());
    expect(homeBackground(root)).toBe(lobbyLeft);
    wait(BACKGROUND_ROTATION_MS);
    expect(homeBackground(root)).not.toBe(lobbyLeft);
  });
});
