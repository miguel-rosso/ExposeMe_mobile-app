import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { AppState, BackHandler } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import OwnPhotos from "../app/screens/OwnPhotos";

// EXP-118: the photo explorer without photo access / photos explains it (instead of a black screen) and loads a
// photo as soon as access is back.

const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockCanGoBack = true;
const mockGetRandomPhoto = jest.fn(async () => null);
const mockCheckGalleryAccess = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack, canGoBack: () => mockCanGoBack }),
}));
jest.mock("@/app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    photoUri: null, setPhotoUri: jest.fn(), getRandomPhoto: mockGetRandomPhoto,
    requestGalleryPermission: jest.fn(async () => false),
    checkGalleryAccess: (o: { ask: boolean }) => mockCheckGalleryAccess(o), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/CloseButton", () => {
  const { TouchableOpacity } = require("react-native");
  return ({ onPress }: { onPress: () => void }) => <TouchableOpacity testID="close-button" onPress={onPress} />;
});
jest.mock("lottie-react-native", () => () => null);
jest.mock("react-native-animatable", () => ({ View: "AnimatableView" }));

let appStateHandlers: ((s: string) => void)[] = [];
let hardwareBackHandlers: (() => boolean | null | undefined)[] = [];
beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return { remove: () => { appStateHandlers = appStateHandlers.filter((x) => x !== h); } };
  }) as typeof AppState.addEventListener);
  hardwareBackHandlers = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation(((_: string, h: () => boolean) => {
    hardwareBackHandlers.push(h);
    return { remove: () => { hardwareBackHandlers = hardwareBackHandlers.filter((x) => x !== h); } };
  }) as typeof BackHandler.addEventListener);
  mockReplace.mockClear();
  mockBack.mockClear();
  mockCanGoBack = true;
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const has = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true }).length > 0;

describe("OwnPhotos gallery access (EXP-118)", () => {
  it("explains missing access, loads a photo once it is back, and Back goes home", async () => {
    mockCheckGalleryAccess.mockResolvedValue({ status: "denied", limited: false, canAskAgain: false });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<OwnPhotos />); });
    await flush();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(true);
    expect(mockGetRandomPhoto).not.toHaveBeenCalled();

    mockCheckGalleryAccess.mockResolvedValue({ status: "ok", limited: true, canAskAgain: true });
    act(() => appStateHandlers.forEach((h) => h("active")));
    await flush();
    expect(has(r.root, TEST_IDS.galleryAccessModal)).toBe(false);
    expect(mockGetRandomPhoto).toHaveBeenCalledTimes(1);

    mockCheckGalleryAccess.mockResolvedValue({ status: "no-photos", limited: false, canAskAgain: true });
    act(() => appStateHandlers.forEach((h) => h("active")));
    await flush();
    act(() => { r.root.find((n) => n.props.testID === TEST_IDS.galleryBackButton && typeof n.props.onPress === "function").props.onPress(); });
    expect(mockBack).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});

// EXP-243: replace("/") stacked a second home over the original one, whose elements were still animated out,
// so a second back showed a home with no buttons. Going back reuses the home the explorer was opened from.
describe("OwnPhotos back (EXP-243)", () => {
  async function mount() {
    mockCheckGalleryAccess.mockResolvedValue({ status: "ok", limited: false, canAskAgain: true });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<OwnPhotos />); });
    await flush();
    return r;
  }

  it("the close button pops back to the home underneath instead of stacking a new one", async () => {
    const r = await mount();
    act(() => { r.root.find((n) => n.props.testID === TEST_IDS.closeButton && typeof n.props.onPress === "function").props.onPress(); });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("Android hardware back pops back too, consuming the press", async () => {
    const r = await mount();
    expect(hardwareBackHandlers).toHaveLength(1);
    let consumed: boolean | null | undefined;
    act(() => { consumed = hardwareBackHandlers[0](); });
    expect(consumed).toBe(true);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => r.unmount());
    expect(hardwareBackHandlers).toHaveLength(0);
  });

  it("with nothing to go back to (opened directly), it goes home", async () => {
    mockCanGoBack = false;
    const r = await mount();
    act(() => { r.root.find((n) => n.props.testID === TEST_IDS.closeButton && typeof n.props.onPress === "function").props.onPress(); });
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });
});
