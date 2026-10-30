import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { TEST_IDS } from "../app/utils/testIds";

// EXP-334: an invite link opened without a name sends the player home (the waiting room leaves the room's code in
// GameContext's pendingInviteCode). Home then opens its join panel with that code filled in and the name field in
// it, so the player only types a name and taps Search. On a fresh install the first-run screen comes first.

let mockHasSeenInitialScreen = "true";
jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? mockHasSeenInitialScreen : null));
  return mock;
});

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
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => "initial-screen");
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/components/LimitedAccessBanner", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
const mockGalleryCheck = jest.fn(async () => ({ status: "ok" }));
jest.mock("@/app/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ check: () => mockGalleryCheck() }),
}));
jest.mock("@/app/components/modals/GalleryAccessModal", () => () => null);

// A stateful game context, like the real provider: the code and pending invite outlive a remount of home
const mockContext = { pendingInviteCode: null as string | null, gameCode: null as string | null };
let mockNameAtPush: string | null | undefined;
jest.mock("../app/providers/GameContext", () => {
  const { useState } = require("react");
  return {
    useGameContext: () => {
      const [username, setUsername] = useState(null);
      const [gameCode, setGameCodeState] = useState(mockContext.gameCode);
      const [pendingInviteCode, setPendingState] = useState(mockContext.pendingInviteCode);
      const setGameCode = (code: string | null) => { mockContext.gameCode = code; setGameCodeState(code); };
      const setPendingInviteCode = (code: string | null) => { mockContext.pendingInviteCode = code; setPendingState(code); };
      mockPush.mockImplementation(() => { mockNameAtPush = username; });
      return { username, setUsername, gameCode, setGameCode, pendingInviteCode, setPendingInviteCode, socket: null, endSocket: () => {} };
    },
  };
});

import Index from "../app/index";

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

const LINKED_ROOM = "XYZ789";

let mounted: TestRenderer.ReactTestRenderer | null = null;
beforeEach(() => {
  mockHasSeenInitialScreen = "true";
  mockContext.pendingInviteCode = LINKED_ROOM; // set by the waiting room before it sent us home
  mockContext.gameCode = LINKED_ROOM;
  mockNameAtPush = undefined;
  mockPush.mockReset();
});
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const input = (root: ReactTestInstance, id: string) => byTestId(root, id).find((n) => typeof n.props.onChange === "function" || typeof n.props.onChangeText === "function");
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await byTestId(root, id).find((n) => typeof n.props.onPress === "function")!.props.onPress(); });
  await flush();
};
/**
 * Presses `id` while the gallery check is still pending, then lets it answer: on a phone that check is a native call,
 * so React renders the saved name before the handler navigates (see homeUsernameNormalize.test.tsx).
 */
const pressBeforeGalleryAnswers = async (root: ReactTestInstance, id: string) => {
  let answerGalleryCheck!: () => void;
  mockGalleryCheck.mockImplementationOnce(() => new Promise((resolve) => {
    answerGalleryCheck = () => resolve({ status: "ok" });
  }));
  let pressed!: Promise<void>;
  act(() => { pressed = byTestId(root, id).find((n) => typeof n.props.onPress === "function")!.props.onPress(); });
  await act(async () => { answerGalleryCheck(); await pressed; });
  await flush();
};
const typeName = async (root: ReactTestInstance, text: string) => {
  await act(async () => { await input(root, TEST_IDS.usernameInput)!.props.onChange({ nativeEvent: { text } }); });
  await flush();
};
const mount = async () => {
  await act(async () => { mounted = TestRenderer.create(<Index />); });
  await flush();
  return mounted!.root;
};

describe("Home after an invite link opened without a name (EXP-334)", () => {
  it("opens the join panel with the link's code and the name field", async () => {
    const root = await mount();
    expect(input(root, TEST_IDS.gameCodeInput)?.props.value).toBe(LINKED_ROOM);
    expect(input(root, TEST_IDS.usernameInput)?.props.value).toBe("");
    expect(byTestId(root, TEST_IDS.searchRoomButton).length).toBeGreaterThan(0);
    expect(mockContext.pendingInviteCode).toBeNull(); // used once
  });

  it("Search joins with the typed name, after the gallery check", async () => {
    const root = await mount();
    await typeName(root, "Ana ");
    await pressBeforeGalleryAnswers(root, TEST_IDS.searchRoomButton);
    expect(mockGalleryCheck).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(mockNameAtPush).toBe("Ana");
  });

  it("Search without a name joins nothing", async () => {
    const root = await mount();
    await press(root, TEST_IDS.searchRoomButton);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("on a fresh install waits for the first-run screen, and opens the panel on the home shown after it", async () => {
    mockHasSeenInitialScreen = "false";
    let root = await mount();
    expect(byTestId(root, TEST_IDS.gameCodeInput)).toHaveLength(0);
    expect(mockContext.pendingInviteCode).toBe(LINKED_ROOM);

    // Its Continue replaces home with a new one
    act(() => mounted!.unmount());
    mockHasSeenInitialScreen = "true";
    root = await mount();
    expect(input(root, TEST_IDS.gameCodeInput)?.props.value).toBe(LINKED_ROOM);
    expect(input(root, TEST_IDS.usernameInput)).toBeDefined();
  });

  it("without a pending invite home opens on its form, the join panel closed", async () => {
    mockContext.pendingInviteCode = null;
    const root = await mount();
    expect(byTestId(root, TEST_IDS.gameCodeInput)).toHaveLength(0);
    expect(byTestId(root, TEST_IDS.createGameButton).length).toBeGreaterThan(0);
  });
});
