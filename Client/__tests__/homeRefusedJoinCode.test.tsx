import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { recordTermsAccepted } from "../src/utils/termsAcceptance";
import { TEST_IDS } from "../src/utils/testIds";

// EXP-342: leaving the game flow forgets the room (GameContext's gameCode), but not the code typed in home's join
// panel. A refused join (name taken, game not found, room full) sends the player back home, whose join panel still
// shows that code, kept in GameContext (so even a home mounted afresh shows it; the way back pops to the same home,
// EXP-339); Search makes it the room to join again. Real GameProvider, real home screen.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
const mockPush = jest.fn();
jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn() }),
    useLocalSearchParams: () => ({}),
    // The screen is focused while mounted: run the callback like an effect
    useFocusEffect: (callback: () => void) => useEffect(() => callback(), [callback]),
  };
});
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => "initial-screen");
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ check: async () => ({ status: "ok" }) }),
}));
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);

import Index from "../app/index";
import { GameProvider, useGameContext } from "../src/providers/GameContext";

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

const TYPED_ROOM = "K7MQ4X";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const codeInput = (root: ReactTestInstance) =>
  byTestId(root, TEST_IDS.gameCodeInput).find((n) => typeof n.props.onChangeText === "function");
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await byTestId(root, id).find((n) => typeof n.props.onPress === "function")!.props.onPress(); });
  await flush();
};

let app: TestRenderer.ReactTestRenderer | null = null;
/** Home as a new screen (a fresh mount, `key` apart) inside the one app-wide GameProvider. */
const showHome = async (key: number) => {
  const tree = <GameProvider><Index key={key} /><Probe /></GameProvider>;
  await act(async () => {
    if (app) app.update(tree);
    else app = TestRenderer.create(tree);
  });
  await flush();
  return app!.root;
};

beforeEach(async () => {
  await AsyncStorage.clear();
  await recordTermsAccepted();
  await AsyncStorage.setItem("username", "ana");
  mockPush.mockReset();
});
afterEach(() => {
  act(() => app?.unmount());
  app = null;
});

describe("Home's typed room code after a refused join (EXP-342)", () => {
  it("is still in the join panel of the new home, while the room itself is forgotten", async () => {
    let root = await showHome(1);
    await press(root, TEST_IDS.joinGameButton);
    act(() => codeInput(root)!.props.onChangeText(TYPED_ROOM.toLowerCase()));
    await press(root, TEST_IDS.searchRoomButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(ctx.gameCode).toBe(TYPED_ROOM);

    // The waiting room's refusal path: endSocket, then a new home
    act(() => ctx.endSocket());
    expect(ctx.gameCode).toBeNull();
    root = await showHome(2);
    await press(root, TEST_IDS.joinGameButton);

    expect(codeInput(root)!.props.value).toBe(TYPED_ROOM);
  });

  it("is only the room to join once Search is pressed", async () => {
    const root = await showHome(1);
    await press(root, TEST_IDS.joinGameButton);
    act(() => codeInput(root)!.props.onChangeText(TYPED_ROOM));
    expect(ctx.gameCode).toBeNull();
  });
});
