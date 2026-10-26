import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-044: the "You" tag next to your own name comes from i18n (es: "Tú"), not hard-coded English.

const mockSocket = new FakeSocket();
// Captures the confirm dialog's props so the test can press "Remove"
const mockAlertProps: { current: any } = { current: null };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), gameCode: "ABC123", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice",
    setRoundsOfGame: jest.fn(), roundsOfGame: 10, setPlantedPhotoUri: jest.fn(),
    saveRejoinToken: jest.fn(), getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
  }),
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/es").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => (props: any) => { mockAlertProps.current = props; return null; });
jest.mock("@/app/components/IngameComunication/ChatMessage", () => () => null);
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const player = (username: string, isHost: boolean) =>
  ({ username, points: 0, isHost, connected: true, lastAnswerCorrect: false, lastGuess: "" });

afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.removeAllListeners();
  mockSocket.emitted = [];
});

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));

describe("WaitingRoom: own-name tag (EXP-044)", () => {
  it("shows the translated tag once, next to my own name only", async () => {
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
    await act(async () => { await Promise.resolve(); });
    act(() => mockSocket.fire("room-of-game", {
      success: true, room: { gameCode: "ABC123", players: [player("alice", true), player("bob", false)], rounds: 10 }, rejoinToken: "tok-123",
    }));
    const all = texts(r);
    expect(all.filter((s) => s === "Tú")).toHaveLength(1);
    expect(all).not.toContain("You");
    act(() => r.unmount());
  });
});

