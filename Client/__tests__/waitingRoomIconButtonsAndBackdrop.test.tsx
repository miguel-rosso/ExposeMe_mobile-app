import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Image } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import en from "../src/i18n/en";
import es from "../src/i18n/es";
import { TEST_IDS } from "../src/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import CloseButton from "../src/components/CloseButton";

// EXP-046: the lobby's icon-only buttons (copy and share the room code, send a chat message, leave the room) have a
// translated name for TalkBack / VoiceOver instead of being announced as a bare "button".
// EXP-262: the blurred background is a single <Image blurRadius>, with no hidden ImageBlur layers under it.

const mockSocket = new FakeSocket();
let mockLang: "es" | "en" = "en";
const mockBackground = 7;

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(), gameCode: "K7MQ4X", setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice", setRoundsOfGame: jest.fn(), roundsOfGame: 10,
    plantedPhotoUri: null, setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
    getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
  }),
}));
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: mockBackground }) }));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
  }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require(`../src/i18n/${mockLang}`).default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/src/components/AnimatedDot", () => () => null);
jest.mock("@/src/components/modals/AlertModal", () => () => null);

/** The lobby background keeps the blur it had with ImageBlur */
const LOBBY_BACKDROP_BLUR_RADIUS = 10;

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
// FlatList schedules cell updates on timers
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockLang = "en";
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function mount(element: React.ReactElement = <WaitingRoom />) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(element); });
  await act(async () => { await Promise.resolve(); });
  return r;
}

/** The native view a screen reader announces with this name: exactly one, announced as a button */
const buttonLabelled = (root: ReactTestInstance, label: string) => {
  const matches = root.findAll((n) => typeof n.type === "string" && n.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  expect(matches[0].props.accessibilityRole).toBe("button");
  return matches[0];
};

describe("WaitingRoom: icon-only buttons have a screen reader name (EXP-046)", () => {
  it.each([["en", en], ["es", es]] as const)("%s: copy, share, send and leave", async (lang, t) => {
    mockLang = lang;
    const r = await mount();
    expect(buttonLabelled(r.root, t.copyGameCode).props.testID).toBe(TEST_IDS.copyCodeButton);
    expect(buttonLabelled(r.root, t.shareGameCode).props.testID).toBe(TEST_IDS.shareCodeButton);
    expect(buttonLabelled(r.root, t.sendMessage).props.testID).toBe(TEST_IDS.chatSendButton);
    expect(buttonLabelled(r.root, t.leaveRoom).props.testID).toBe(TEST_IDS.closeButton);
    act(() => r.unmount());
  });

  it("a close button elsewhere (Photo Explorer) is announced as Close", async () => {
    const r = await mount(<CloseButton onPress={jest.fn()} />);
    expect(buttonLabelled(r.root, en.close).props.testID).toBe(TEST_IDS.closeButton);
    act(() => r.unmount());
  });

  it("the labels are translated, not the same text in both languages", () => {
    for (const key of ["copyGameCode", "shareGameCode", "sendMessage", "leaveRoom", "close"] as const) {
      expect(es[key]).not.toBe(en[key]);
    }
  });
});

describe("WaitingRoom: blurred background (EXP-262)", () => {
  it("is one blurred <Image> of the background, without ImageBlur", async () => {
    const r = await mount();
    const blurred = r.root.findAll((n) => n.type === Image && n.props.blurRadius !== undefined);
    expect(blurred).toHaveLength(1);
    expect(blurred[0].props).toMatchObject({ source: mockBackground, blurRadius: LOBBY_BACKDROP_BLUR_RADIUS, resizeMode: "cover" });
    expect(r.root.findAll((n) => typeof n.type === "function" && n.type.name === "ImageBlur").map((n) => n.type)).toEqual([]);
    act(() => r.unmount());
  });
});
