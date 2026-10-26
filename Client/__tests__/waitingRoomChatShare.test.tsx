import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, Keyboard, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-186: the lobby chat (sending, the cooldown between messages, other players' messages, fading out) and the
// buttons that copy the room code and share the invite link.

const mockSocket = new FakeSocket();
const mockCtx: { gameCode: string | null } = { gameCode: "K7MQ4X" };

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("../app/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: jest.fn(), gameCode: mockCtx.gameCode, setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice", setRoundsOfGame: jest.fn(), roundsOfGame: 10,
    plantedPhotoUri: null, setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
    getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
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
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/app/components/ImageBlur/ImageBlur", () => () => null);
jest.mock("@/app/components/ImageBlur", () => ({ ImageBlurView: () => null }));
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
// A chat bubble as a host element: the test reads who said what and ends its fade-out itself
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => "SuccessAlert");

const ROOM_CODE = "K7MQ4X";
// The lobby's minimum time between two messages of mine
const CHAT_COOLDOWN_MS = 1_000;
// How long the "code copied" notice stays
const COPY_NOTICE_MS = 2_000;

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

let alertSpy: jest.SpyInstance;
let dismissSpy: jest.SpyInstance;
let shareSpy: jest.SpyInstance;

// FlatList schedules cell updates on timers: keep them on fake timers (they also drive Date.now for the cooldown)
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  [alertSpy, dismissSpy, shareSpy].forEach((spy) => spy.mockRestore());
});
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
  mockCtx.gameCode = ROOM_CODE;
  (Clipboard.setStringAsync as jest.Mock).mockClear();
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  dismissSpy = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
  shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
});

async function mount() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  return r;
}

const byId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  r.root.find((n) => n.props.testID === id && typeof n.type === "string");
const pressId = (r: TestRenderer.ReactTestRenderer, id: string) =>
  act(async () => { await r.root.find((n) => n.props.testID === id && typeof n.props.onPress === "function").props.onPress(); });
const typeChat = (r: TestRenderer.ReactTestRenderer, text: string) =>
  act(() => { byId(r, TEST_IDS.chatInput).props.onChangeText(text); });
const sendChat = (r: TestRenderer.ReactTestRenderer) => pressId(r, TEST_IDS.chatSendButton);

const chatShown = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "ChatMessage").map((n) => ({ username: n.props.username, message: n.props.message }));
const notices = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => (n.type as unknown) === "SuccessAlert").map((n) => n.props.text);

// ── Chat ─────────────────────────────────────────────────

describe("WaitingRoom: lobby chat (EXP-186)", () => {
  it("sends the trimmed message to the room, shows it to me at once, clears the input and closes the keyboard", async () => {
    const r = await mount();
    await typeChat(r, "  hola a todos  ");
    expect(byId(r, TEST_IDS.chatSendButton).props.accessibilityState?.disabled).toBeFalsy();

    await sendChat(r);
    expect(mockSocket.emittedPayloads("chat-message")).toEqual([{ gameCode: ROOM_CODE, username: "alice", message: "hola a todos" }]);
    expect(chatShown(r)).toEqual([{ username: "alice", message: "hola a todos" }]);
    expect(byId(r, TEST_IDS.chatInput).props.value).toBe("");
    expect(dismissSpy).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("a blank message can't be sent: the button is disabled and sends nothing", async () => {
    const r = await mount();
    expect(byId(r, TEST_IDS.chatSendButton).props.accessibilityState?.disabled).toBe(true);
    await typeChat(r, "   ");
    expect(byId(r, TEST_IDS.chatSendButton).props.accessibilityState?.disabled).toBe(true);

    await sendChat(r);
    expect(mockSocket.emittedPayloads("chat-message")).toEqual([]);
    expect(chatShown(r)).toEqual([]);
    act(() => r.unmount());
  });

  it("a second message within the cooldown is held back with a warning, and goes once the cooldown is over", async () => {
    const r = await mount();
    await typeChat(r, "uno");
    await sendChat(r);

    act(() => jest.advanceTimersByTime(CHAT_COOLDOWN_MS - 1));
    await typeChat(r, "dos");
    await sendChat(r);
    expect(alertSpy).toHaveBeenCalledWith(en.slowDown, en.pleaseWaitBeforeSending);
    expect(mockSocket.emittedPayloads("chat-message").map((m) => m.message)).toEqual(["uno"]);
    expect(byId(r, TEST_IDS.chatInput).props.value).toBe("dos"); // kept, to send it later

    act(() => jest.advanceTimersByTime(1));
    await sendChat(r);
    expect(mockSocket.emittedPayloads("chat-message").map((m) => m.message)).toEqual(["uno", "dos"]);
    expect(chatShown(r).map((m) => m.message)).toEqual(["uno", "dos"]);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("shows other players' messages with their name, and ignores an echo of my own", async () => {
    const r = await mount();
    act(() => mockSocket.fire("chat-message", { username: "bob", message: "hey" }));
    act(() => mockSocket.fire("chat-message", { username: "alice", message: "echo of mine" }));
    act(() => mockSocket.fire("chat-message", { username: "carol", message: "hi!" }));
    expect(chatShown(r)).toEqual([
      { username: "bob", message: "hey" },
      { username: "carol", message: "hi!" },
    ]);
    act(() => r.unmount());
  });

  it("a message leaves the screen when its fade-out ends, the others stay", async () => {
    const r = await mount();
    act(() => mockSocket.fire("chat-message", { username: "bob", message: "first" }));
    act(() => mockSocket.fire("chat-message", { username: "carol", message: "second" }));
    const first = r.root.find((n) => (n.type as unknown) === "ChatMessage" && n.props.message === "first");

    act(() => first.props.onAnimationEnd());
    expect(chatShown(r)).toEqual([{ username: "carol", message: "second" }]);
    act(() => r.unmount());
  });
});

// ── Copy and share the room code ─────────────────────────

describe("WaitingRoom: copy the code and share the invite link (EXP-186)", () => {
  it("copy puts the room code on the clipboard and shows a notice for a moment", async () => {
    const r = await mount();
    await pressId(r, TEST_IDS.copyCodeButton);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(ROOM_CODE);
    expect(notices(r)).toEqual([en.gameCodeCopied]);

    act(() => jest.advanceTimersByTime(COPY_NOTICE_MS - 1));
    expect(notices(r)).toEqual([en.gameCodeCopied]);
    act(() => jest.advanceTimersByTime(1));
    expect(notices(r)).toEqual([]);
    act(() => r.unmount());
  });

  it("share opens the share sheet with the invite text and the room's join link", async () => {
    const r = await mount();
    await pressId(r, TEST_IDS.shareCodeButton);
    expect(shareSpy).toHaveBeenCalledTimes(1);
    const { message } = shareSpy.mock.calls[0][0] as { message: string };
    expect(message.startsWith(en.shareMessage)).toBe(true);
    expect(message.slice(en.shareMessage.length)).toMatch(new RegExp(`^https://[^\\s/]+/join/${ROOM_CODE}$`));
    act(() => r.unmount());
  });

  it("a failed or dismissed share sheet is ignored: the lobby stays as it was", async () => {
    shareSpy.mockRejectedValueOnce(new Error("User did not share"));
    const r = await mount();
    await pressId(r, TEST_IDS.shareCodeButton);
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(byId(r, TEST_IDS.lobbyGameCode).props.children).toBe(ROOM_CODE);
    act(() => r.unmount());
  });

  it("before the room has a code (creating it) neither copy nor share does anything", async () => {
    mockCtx.gameCode = null;
    const r = await mount();
    await pressId(r, TEST_IDS.copyCodeButton);
    await pressId(r, TEST_IDS.shareCodeButton);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    expect(shareSpy).not.toHaveBeenCalled();
    expect(notices(r)).toEqual([]);
    act(() => r.unmount());
  });
});
