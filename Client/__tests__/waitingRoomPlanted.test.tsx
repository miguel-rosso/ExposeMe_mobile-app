import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { ActivityIndicator, Alert } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { PLANT_FAILED_NOTICE_MS } from "../app/components/PlantPhotoButton";

// EXP-035 / EXP-126: the photo is planted from the lobby as soon as it is picked (upload + plant-photo, uncropped).
// The lobby shows "planted" once the server has the photo picked for this game (plantedPhotoSent; the context drops it
// after a game, EXP-269: not while it uploads or after its upload failed) or when the server says it has mine
// (room-of-game `hasPlantedPhoto`, my own mark only). A rejoin into a started game leaves it alone.

const mockSocket = new FakeSocket();
// Context planted photo: a plain holder, read on every render (the provider re-renders with the new value)
const mockPlanted: { uri: string | null; sent: boolean; upload: "idle" | "uploading" | "failed" } = {
  uri: null, sent: false, upload: "idle",
};
const mockSetPlantedPhotoUri = jest.fn((uri: string | null) => {
  mockPlanted.uri = uri;
  mockPlanted.sent = false;
  mockPlanted.upload = "idle";
});
/** Like the context: true (and plantedPhotoSent) once the server has the photo. */
const mockPlantPhoto = jest.fn(async () => { mockPlanted.sent = true; return true; });
/** A plantPhoto still uploading (plantUpload "uploading") until the test settles it as the context would. */
const pendingPlant = () => {
  const settle = { confirm: () => {}, giveUp: () => {} };
  mockPlantPhoto.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
    mockPlanted.upload = "uploading";
    settle.confirm = () => { mockPlanted.sent = true; mockPlanted.upload = "idle"; resolve(true); };
    settle.giveUp = () => { mockPlanted.upload = "failed"; resolve(false); };
  }));
  return settle;
};

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
    plantedPhotoSent: mockPlanted.sent, plantUpload: mockPlanted.upload,
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
const expectPlanted = (
  r: TestRenderer.ReactTestRenderer,
  planted: boolean,
  label: string = planted ? en.photoPlanted : en.plantPhoto,
) => {
  expect(has(r, TEST_IDS.plantPhotoPlanted)).toBe(planted);
  expect(has(r, TEST_IDS.plantPhotoNotPlanted)).toBe(!planted);
  const labels = plantButton(r).findAll((n) => typeof n.props.children === "string").map((n) => n.props.children);
  expect(labels).toContain(label);
};
const hasPhotoAddedAlert = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.text === en.photoSelectedForGame).length > 0;
const isUploading = (r: TestRenderer.ReactTestRenderer) =>
  plantButton(r).findAll((n) => n.type === ActivityIndicator).length > 0;
const hasFailedNotice = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.children === en.plantPhotoFailed).length > 0;
const rerender = (r: TestRenderer.ReactTestRenderer) => act(async () => { r.update(<WaitingRoom />); });
const pickPhoto = async (r: TestRenderer.ReactTestRenderer) => {
  await act(async () => { plantButton(r).props.onPress(); });
  await flush();
  await rerender(r); // the provider re-renders with the new value
};
const plantEvents = () => mockSocket.emitted.filter(([ev]) => ev === "mark-player-planted" || ev === "plant-photo");

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
  mockPlanted.uri = null;
  mockPlanted.sent = false;
  mockPlanted.upload = "idle";
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

  it("picking a photo plants it right away, uncropped, shows it uploading, then planted once the server has it", async () => {
    const picker = require("expo-image-picker");
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const plant = pendingPlant();
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    await pickPhoto(r);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: false }));
    expect(mockSetPlantedPhotoUri).toHaveBeenCalledWith("file:///picked.jpg");
    expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
    // Still uploading (e.g. retrying while the server is busy, EXP-269): pending, not planted
    expectPlanted(r, false, en.plantingPhoto);
    expect(isUploading(r)).toBe(true);
    expect(hasPhotoAddedAlert(r)).toBe(false);
    await act(async () => { plant.confirm(); });
    await rerender(r);
    expectPlanted(r, true);
    expect(isUploading(r)).toBe(false);
    expect(hasPhotoAddedAlert(r)).toBe(true);
    expect(plantEvents()).toEqual([]); // the context sends plant-photo, the lobby sends no mark of its own
    alert.mockRestore();
    act(() => r.unmount());
  });

  it("EXP-269: a planted photo the server never got (busy, retries spent) is not planted, with a short notice", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const plant = pendingPlant();
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    await pickPhoto(r);
    expect(hasFailedNotice(r)).toBe(false);
    await act(async () => { plant.giveUp(); });
    await rerender(r);
    expect(mockPlanted.uri).toBe("file:///picked.jpg");
    expectPlanted(r, false);
    expect(isUploading(r)).toBe(false);
    expect(hasPhotoAddedAlert(r)).toBe(false);
    expect(hasFailedNotice(r)).toBe(true);
    await act(async () => { jest.advanceTimersByTime(PLANT_FAILED_NOTICE_MS); });
    expect(hasFailedNotice(r)).toBe(false);
    alert.mockRestore();
    act(() => r.unmount());
  });

  it("EXP-269: replacing a planted photo keeps showing planted while the new one uploads", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    await pickPhoto(r); // first photo: in at once
    expectPlanted(r, true);
    const replacement = pendingPlant();
    await pickPhoto(r); // "change photo"
    expect(mockPlanted.sent).toBe(false); // the context's flag is about the new photo...
    expectPlanted(r, true); // ...but the server still has my earlier one
    expect(isUploading(r)).toBe(true);
    await act(async () => { replacement.giveUp(); });
    await rerender(r);
    expectPlanted(r, true); // the earlier one is still planted
    expect(hasFailedNotice(r)).toBe(true);
    alert.mockRestore();
    act(() => r.unmount());
  });

  it("EXP-269: the server's own mark (room-of-game) also keeps a replacement shown as planted", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(true)));
    pendingPlant();
    await pickPhoto(r);
    expectPlanted(r, true);
    expect(isUploading(r)).toBe(true);
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
    expectPlanted(r, false); // picked, but not sent
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    expect(mockPlantPhoto).toHaveBeenCalledTimes(1);
    await act(async () => { r.update(<WaitingRoom />); });
    expectPlanted(r, true);
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

// ── Busy overlays (EXP-330 characterization) ─────────────

const textsIn = (node: TestRenderer.ReactTestInstance) =>
  node.findAll((n) => typeof n.type === "string" && typeof n.props.children === "string").map((n) => n.props.children);

describe("WaitingRoom: busy overlays", () => {
  it("until the room answers, a loading overlay says it is loading the room and asks to wait", async () => {
    const r = await mount();
    const loading = r.root.find((n) => n.props.testID === TEST_IDS.lobbyLoading && typeof n.type === "string");
    expect(textsIn(loading)).toEqual([en.loadingGameRoom, en.pleaseWait]);
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    expect(has(r, TEST_IDS.lobbyLoading)).toBe(false);
    act(() => r.unmount());
  });

  it("while the gallery picker is open an overlay says a photo is being selected, and the plant button is disabled", async () => {
    const picker = require("expo-image-picker");
    let closePicker!: () => void;
    picker.launchImageLibraryAsync.mockImplementationOnce(
      () => new Promise((resolve) => { closePicker = () => resolve({ canceled: true, assets: null }); })
    );
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.[1]?.onPress?.(); });
    const r = await mount();
    act(() => mockSocket.fire("room-of-game", roomOfGame(false)));
    const selectingShown = () => r.root.findAll((n) => n.props.children === en.selectingPhoto).length > 0;
    expect(selectingShown()).toBe(false);

    await act(async () => { plantButton(r).props.onPress(); });
    await flush();
    expect(selectingShown()).toBe(true);
    expect(plantButton(r).props.disabled).toBe(true);

    await act(async () => { closePicker(); });
    expect(selectingShown()).toBe(false);
    expect(mockPlantPhoto).not.toHaveBeenCalled();
    alert.mockRestore();
    act(() => r.unmount());
  });
});
