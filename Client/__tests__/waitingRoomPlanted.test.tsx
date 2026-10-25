import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-035 / EXP-126: the photo is planted from the lobby as soon as it is picked (upload + plant-photo, uncropped).
// The lobby shows "planted" for a photo picked for this game (the context drops it after a game) or when the server
// has mine (room-of-game `hasPlantedPhoto`, my own mark only). A rejoin into a started game leaves it alone.

// ── Fake socket ──────────────────────────────────────────

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn?: Handler) {
    if (fn) this.handlers.get(ev)?.delete(fn);
    else this.handlers.delete(ev);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
}

const mockSocket = new FakeSocket();
// Context planted photo: a plain holder, read on every render (the provider re-renders with the new value)
const mockPlanted: { uri: string | null } = { uri: null };
const mockSetPlantedPhotoUri = jest.fn((uri: string | null) => { mockPlanted.uri = uri; });
const mockPlantPhoto = jest.fn(async () => true);

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "bob",
    setRoundsOfGame: jest.fn(), roundsOfGame: 10,
    plantedPhotoUri: mockPlanted.uri, setPlantedPhotoUri: mockSetPlantedPhotoUri, plantPhoto: mockPlantPhoto,
    saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(async () => true),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: "file:///picked.jpg" }] })),
}));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);

const flush = () => act(async () => { await Promise.resolve(); });

const players = [
  { username: "alice", isHost: true, connected: true },
  { username: "bob", isHost: false, connected: true },
] as any[];
const roomOfGame = (hasPlantedPhoto: boolean, started = false) => ({
  success: true, room: { gameCode: "ABC123", players, rounds: 10, started }, rejoinToken: "tok-123", hasPlantedPhoto,
});

const mount = async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await flush();
  return r;
};
const plantButton = (r: TestRenderer.ReactTestRenderer) =>
  r.root.find((n) => n.props.testID === TEST_IDS.plantPhotoButton && typeof n.props.onPress === "function");
const has = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id).length > 0;
const expectPlanted = (r: TestRenderer.ReactTestRenderer, planted: boolean) => {
  expect(has(r, TEST_IDS.plantPhotoPlanted)).toBe(planted);
  expect(has(r, TEST_IDS.plantPhotoNotPlanted)).toBe(!planted);
  const labels = plantButton(r).findAll((n) => typeof n.props.children === "string").map((n) => n.props.children);
  expect(labels).toContain(planted ? en.photoPlanted : en.plantPhoto);
};
const plantEvents = () => mockSocket.emitted.filter(([ev]) => ev === "mark-player-planted" || ev === "plant-photo");

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
  mockPlanted.uri = null;
  mockSetPlantedPhotoUri.mockClear();
  mockPlantPhoto.mockClear();
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe("WaitingRoom: planted photo state", () => {
  it("back in the lobby after a game (context cleared, server cleared): shows not planted", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    expectPlanted(r, false);
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("picking a photo plants it right away, uncropped, and shows it planted", async () => {
    const picker = require("expo-image-picker");
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    await act(async () => { plantButton(r).props.onPress(); });
    await flush();
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: false }));
    expect(mockSetPlantedPhotoUri).toHaveBeenCalledWith("file:///picked.jpg");
    expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
    await act(async () => { r.update(<WaitingRoom />); }); // the provider re-renders with the new value
    expectPlanted(r, true);
    expect(plantEvents()).toEqual([]); // the context sends plant-photo, the lobby sends no mark of its own
    alert.mockRestore();
    act(() => r.unmount());
  });

  it("the server already has my planted photo (app reopened in the lobby): shows planted", async () => {
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(true)));
    expectPlanted(r, true);
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("picked photo the server doesn't have (upload failed / new socket): plants it again from the lobby", async () => {
    mockPlanted.uri = "file:///picked.jpg";
    const r = await mount();
    expectPlanted(r, true);
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("rejoin into a started game: leaves the planted photo alone", async () => {
    mockPlanted.uri = "file:///picked.jpg";
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false, true)));
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    expect(plantEvents()).toEqual([]);
    act(() => r.unmount());
  });
});
