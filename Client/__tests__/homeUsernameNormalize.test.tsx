import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { TEST_IDS } from "../src/utils/testIds";
import { normalizeUsername } from "../src/utils/username";

// EXP-263: the home screen saves and sends the name without stray spaces (iOS autocorrect adds a trailing one), so
// others never see «Ana  María ». Typing stays free: the name is normalized on Create / Join, not on every keystroke.

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : null));
  return mock;
});

// The game context's name on its last render, and its value when the app navigates to the waiting room (which
// mounts with it and sends it to the server)
let mockCurrentName: string | null = null;
/** Every name home asked the game context to save (GameContext.saveUsername persists it for the next launch) */
const mockSavedNames: string[] = [];
let nameAtPush: string | null | undefined;
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../src/components/LanguageToggle", () => () => null);
jest.mock("../src/components/LimitedAccessBanner", () => () => null);
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
const mockGalleryCheck = jest.fn(async () => ({ status: "ok" }));
jest.mock("@/src/hooks/useGalleryAccessGuard", () => ({
  useGalleryAccessGuard: () => ({ check: () => mockGalleryCheck() }),
}));
jest.mock("@/src/components/modals/GalleryAccessModal", () => () => null);
// A stateful game context, like the real provider's username / gameCode / join code draft state
jest.mock("../src/providers/GameContext", () => {
  const { useState } = require("react");
  return {
    useGameContext: () => {
      const [username, setUsername] = useState(null);
      const [gameCode, setGameCode] = useState(null);
      const [joinCodeDraft, setJoinCodeDraft] = useState("K7MQ4X");
      mockCurrentName = username;
      const requestNewRoom = () => setGameCode(null);
      const saveUsername = (name: string) => {
        mockSavedNames.push(name);
        setUsername(name);
      };
      return {
        username, saveUsername, gameCode, setGameCode, joinCodeDraft, setJoinCodeDraft, requestNewRoom,
        socket: null, endSocket: () => {},
      };
    },
  };
});

import Index from "../app/index";

beforeAll(() => jest.spyOn(console, "log").mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  nameAtPush = undefined;
  mockPush.mockReset();
  mockPush.mockImplementation(() => { nameAtPush = mockCurrentName; });
  mockSavedNames.length = 0;
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const byTestId = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await byTestId(root, id).find((n) => typeof n.props.onPress === "function")!.props.onPress(); });
  await flush();
};
/**
 * Presses `id` while the gallery check is still pending, then lets it answer. On a phone that check is a native call,
 * so React renders what the press changed before it answers; one act() around both would hold that render until the
 * handler had already navigated.
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
  const input = byTestId(root, TEST_IDS.usernameInput).find((n) => typeof n.props.onChange === "function")!;
  await act(async () => { await input.props.onChange({ nativeEvent: { text } }); });
  await flush();
};
const inputValue = (root: ReactTestInstance) =>
  byTestId(root, TEST_IDS.usernameInput).find((n) => typeof n.props.onChange === "function")!.props.value;
const storedNames = () => mockSavedNames;

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<Index />); });
  await flush();
  return r;
}

describe("normalizeUsername", () => {
  it.each([
    ["Ana María ", "Ana María"],
    ["  Ana  María  ", "Ana María"],
    ["Ana\u00A0\u00A0María", "Ana María"],
    ["Ana\tMaría\n", "Ana María"],
    ["¯\\_(ツ)_/¯", "¯\\_(ツ)_/¯"],
    ["   ", ""],
    ["", ""],
    [null, ""],
  ])("%j → %j", (typed, expected) => {
    expect(normalizeUsername(typed)).toBe(expected);
  });
});

describe("Home screen name (EXP-263)", () => {
  it("keeps the space being typed between two words", async () => {
    const r = await mount();
    await typeName(r.root, "Ana ");
    expect(inputValue(r.root)).toBe("Ana ");
    await typeName(r.root, "Ana  M");
    expect(inputValue(r.root)).toBe("Ana  M");
    act(() => r.unmount());
  });

  it("Create game saves and sends the name without stray spaces", async () => {
    const r = await mount();
    await typeName(r.root, " Ana  María ");
    await pressBeforeGalleryAnswers(r.root, TEST_IDS.createGameButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(nameAtPush).toBe("Ana María");
    expect(storedNames().at(-1)).toBe("Ana María");
    act(() => r.unmount());
  });

  it("Join game saves the name without stray spaces before searching the room", async () => {
    const r = await mount();
    await typeName(r.root, "Ana María ");
    await press(r.root, TEST_IDS.joinGameButton);
    expect(storedNames().at(-1)).toBe("Ana María");
    await press(r.root, TEST_IDS.searchRoomButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(nameAtPush).toBe("Ana María");
    act(() => r.unmount());
  });

  it("a name made only of spaces counts as empty: no game is created or joined", async () => {
    const r = await mount();
    await typeName(r.root, "   ");
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockPush).not.toHaveBeenCalled();
    await press(r.root, TEST_IDS.joinGameButton);
    expect(byTestId(r.root, TEST_IDS.searchRoomButton)).toHaveLength(0);
    act(() => r.unmount());
  });

  // A name saved with stray spaces by an older version loads normalized: GameProvider loads it at app start
  // (waitingRoomColdInvite.test.tsx, EXP-334)
});
