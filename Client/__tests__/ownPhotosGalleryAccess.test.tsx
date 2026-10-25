import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { AppState } from "react-native";
import { TEST_IDS } from "../app/utils/testIds";
import OwnPhotos from "../app/screens/OwnPhotos";

// EXP-118: the photo explorer without photo access / photos explains it (instead of a black screen) and loads a
// photo as soon as access is back.

const mockReplace = jest.fn();
const mockGetRandomPhoto = jest.fn(async () => null);
const mockCheckGalleryAccess = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("@/app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    photoUri: null, setPhotoUri: jest.fn(), getRandomPhoto: mockGetRandomPhoto,
    requestGalleryPermission: jest.fn(async () => false),
    checkGalleryAccess: (o: { ask: boolean }) => mockCheckGalleryAccess(o), selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("@/app/components/PhotoComponent", () => () => null);
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("lottie-react-native", () => () => null);
jest.mock("react-native-animatable", () => ({ View: "AnimatableView" }));

let appStateHandlers: ((s: string) => void)[] = [];
beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => jest.restoreAllMocks());
beforeEach(() => {
  appStateHandlers = [];
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
    appStateHandlers.push(h);
    return { remove: () => { appStateHandlers = appStateHandlers.filter((x) => x !== h); } };
  }) as typeof AppState.addEventListener);
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
    expect(mockReplace).toHaveBeenCalledWith("/");
    act(() => r.unmount());
  });
});
