import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { AppState } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import { MAX_USERNAME_INPUT_LENGTH } from "../app/utils/protocolLimits";

// EXP-118: Create / Search room require photo permission (full or limited) and at least one visible photo.
// Limited access with photos plays; anything missing is explained on the home screen (never SettingsInstructions).

jest.mock("@react-native-async-storage/async-storage", () => {
  const mock = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
  mock.getItem = jest.fn(async (k: string) => (k === "hasSeenInitialScreen" ? "true" : k === "username" ? "ana" : null));
  return mock;
});

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: () => {},
}));
jest.mock("expo-splash-screen", () => ({ preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() }));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@react-native-community/hooks", () => ({ useBackHandler: () => {} }));
jest.mock("@/app/screens/InitialScreen", () => () => null);
jest.mock("../app/components/LanguageToggle", () => () => null);
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: 1 }) }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
const mockSetGameCode = jest.fn();
let mockGameCode: string | null = null;
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    username: "ana", setUsername: jest.fn(), gameCode: mockGameCode, setGameCode: mockSetGameCode, socket: null, endSocket: jest.fn(),
  }),
}));

// Real PhotoProvider over a mocked expo-media-library
let mockPerm: { status: string; canAskAgain: boolean; accessPrivileges?: string } = { status: "granted", canAskAgain: true };
let mockAfterPrompt = mockPerm;
const mockPhotos: { id: string; mediaType: string }[] = [];
const mockRequest = jest.fn(async () => mockAfterPrompt);
const mockPicker = jest.fn(async () => {});
const mockGalleryListeners: ((e: unknown) => void)[] = [];
jest.mock("expo-media-library", () => {
  class Query {
    eq() { return this; }
    limit() { return this; }
    async exeForMetadata() { return mockPhotos; }
  }
  return {
    getPermissionsAsync: async () => mockPerm,
    requestPermissionsAsync: () => mockRequest(),
    presentPermissionsPicker: () => mockPicker(),
    addListener: (l: (e: unknown) => void) => {
      mockGalleryListeners.push(l);
      return { remove: () => mockGalleryListeners.splice(mockGalleryListeners.indexOf(l), 1) };
    },
    Query,
    Asset: class {},
    AssetField: { MEDIA_TYPE: "mediaType" },
    MediaType: { IMAGE: "image" },
  };
});

import Index from "../app/index";
import { PhotoProvider } from "../app/providers/PhotoContext";

let appStateHandlers: ((s: string) => void)[] = [];
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  jest.useFakeTimers();
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return { remove: () => { appStateHandlers = appStateHandlers.filter((x) => x !== h); } };
  }) as typeof AppState.addEventListener);
  mockPush.mockClear();
  mockReplace.mockClear();
  mockRequest.mockClear();
  mockPicker.mockClear();
  mockPhotos.length = 0;
  mockGalleryListeners.length = 0;
  mockGameCode = null;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;
const press = async (root: ReactTestInstance, id: string) => {
  await act(async () => { await root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress(); });
  await flush();
};
const navigatedTo = (path: string) => [...mockPush.mock.calls, ...mockReplace.mock.calls].some(([p]) => JSON.stringify(p).includes(path));

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<PhotoProvider><Index /></PhotoProvider>); });
  await flush();
  return r;
}

describe("Home Create/Join gallery gate (EXP-118)", () => {
  it("limited access with a selected photo: creates the game, never SettingsInstructions", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "limited" };
    mockPhotos.push({ id: "p1", mediaType: "image" });
    const r = await mount();
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(navigatedTo("SettingsInstructions")).toBe(false);
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
  });

  it("limited access with a selected photo: joins a room", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "limited" };
    mockPhotos.push({ id: "p1", mediaType: "image" });
    mockGameCode = "K7MQ4X";
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    await press(r.root, TEST_IDS.searchRoomButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    expect(navigatedTo("SettingsInstructions")).toBe(false);
    act(() => r.unmount());
  });

  it("limited access with nothing selected: stays home, offers to select photos, then plays", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "limited" };
    const r = await mount();
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockPush).not.toHaveBeenCalled();
    expect(navigatedTo("SettingsInstructions")).toBe(false);
    expect(has(r.root, TEST_IDS.gallerySelectPhotosButton)).toBe(true);

    // While blocked it listens for gallery / selection changes
    expect(mockGalleryListeners).toHaveLength(1);
    // iOS: the picker call resolves as soon as the picker opens, before anything is picked
    await press(r.root, TEST_IDS.gallerySelectPhotosButton);
    expect(mockPicker).toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.gallerySelectPhotosButton)).toBe(true);
    expect(has(r.root, TEST_IDS.galleryRetryButton)).toBe(true);

    // The user picks a photo and closes the picker: the library change event clears the notice (no foreground event)
    mockPhotos.push({ id: "p1", mediaType: "image" });
    act(() => mockGalleryListeners.forEach((l) => l({ hasIncrementalChanges: false })));
    await flush();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    expect(mockGalleryListeners).toHaveLength(0); // unsubscribed once unblocked
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockPush).toHaveBeenCalledWith("/screens/WaitingRoom");
    act(() => r.unmount());
  });

  it("limited access: Try again re-checks after picking (no change event)", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "limited" };
    const r = await mount();
    await press(r.root, TEST_IDS.createGameButton);
    await press(r.root, TEST_IDS.gallerySelectPhotosButton);
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    mockPhotos.push({ id: "p1", mediaType: "image" });
    await press(r.root, TEST_IDS.galleryRetryButton);
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
    expect(mockGalleryListeners).toHaveLength(0);
  });

  it("undetermined: asks once; refusing for good explains and offers Settings, staying home", async () => {
    mockPerm = { status: "undetermined", canAskAgain: true };
    mockAfterPrompt = { status: "denied", canAskAgain: false, accessPrivileges: "none" };
    mockPhotos.push({ id: "p1", mediaType: "image" });
    const r = await mount();
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.gallerySettingsButton)).toBe(true);
    expect(has(r.root, TEST_IDS.galleryAllowButton)).toBe(false);

    // Comes back from Settings with access granted: the notice clears itself
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "all" };
    act(() => appStateHandlers.forEach((h) => h("active")));
    await flush();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
  });

  it("empty gallery: tells the player at least one photo is needed", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "all" };
    const r = await mount();
    await press(r.root, TEST_IDS.createGameButton);
    expect(mockPush).not.toHaveBeenCalled();
    expect(has(r.root, TEST_IDS.galleryRetryButton)).toBe(true);
    await press(r.root, TEST_IDS.galleryBackButton);
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    act(() => r.unmount());
  });
});

describe("Home join field: alphanumeric room codes (EXP-198)", () => {
  const codeInput = (root: ReactTestInstance) =>
    root.find((n) => n.props.testID === TEST_IDS.gameCodeInput && typeof n.props.onChangeText === "function");

  it("uses a letters keyboard, uppercases as you type or paste and keeps at most 6 code characters", async () => {
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    const input = codeInput(r.root);
    expect(input.props.keyboardType ?? "default").toBe("default");
    expect(input.props.autoCapitalize).toBe("characters");
    // No native maxLength: it would cut a pasted " K7MQ4X" / "K7MQ-4X" to 5 code characters before sanitizing
    expect(input.props.maxLength).toBeUndefined();
    act(() => input.props.onChangeText("k7 mq-4x"));
    expect(mockSetGameCode).toHaveBeenLastCalledWith("K7MQ4X");
    act(() => input.props.onChangeText(" K7MQ4X"));
    expect(mockSetGameCode).toHaveBeenLastCalledWith("K7MQ4X");
    act(() => input.props.onChangeText("K7MQ4XZZZ"));
    expect(mockSetGameCode).toHaveBeenLastCalledWith("K7MQ4X");
    act(() => r.unmount());
  });

  it("an incomplete code does not search", async () => {
    mockPerm = { status: "granted", canAskAgain: true, accessPrivileges: "all" };
    mockPhotos.push({ id: "p1", mediaType: "image" });
    mockGameCode = "K7MQ";
    const r = await mount();
    await press(r.root, TEST_IDS.joinGameButton);
    await press(r.root, TEST_IDS.searchRoomButton);
    expect(mockPush).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});

// EXP-217: the app's own name limit (protocol-constants.test.sh keeps it within the server's MAX_USERNAME_LENGTH)
describe("Home name field: length limit (EXP-217)", () => {
  it("takes at most MAX_USERNAME_INPUT_LENGTH characters", async () => {
    const r = await mount();
    const input = r.root.find((n) => n.props.testID === TEST_IDS.usernameInput && typeof n.props.onChange === "function");
    expect(input.props.maxLength).toBe(MAX_USERNAME_INPUT_LENGTH);
    act(() => r.unmount());
  });
});
