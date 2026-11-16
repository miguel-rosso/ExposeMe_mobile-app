import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { chatReportId, lobbyMuteId, reportReasonId, TEST_IDS } from "../src/utils/testIds";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-423 / DEC-052 A: «Report» on another player's lobby chat bubble. A flag next to the author's name (never on my
// own bubbles) opens the reason picker; report-content names the bubble by its author and text (chat messages have no
// ids). Picking the reason also mutes the author for me (EXP-438, on this device only): their bubbles go at once, and
// the answer tells me they are muted.

const mockSocket = new FakeSocket();
const mockLeaveRoom = jest.fn();
// The screen's Android hardware back handler, captured so a test can press back
const mockBack: { handler?: () => boolean } = {};
jest.mock("@react-native-community/hooks", () => ({
  useBackHandler: (handler: () => boolean) => { mockBack.handler = handler; },
}));
// A room code per test: mutes last for the room, so every test starts with nobody muted
let mockGameCode = "K7MQ40";

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), dismissTo: jest.fn() }),
  useLocalSearchParams: () => ({}),
  ...require("../testUtils/screenNavigation").screenNavigationMock(),
}));
jest.mock("../src/providers/GameContext", () => ({
  useGameContext: () => ({
    startSocket: jest.fn(), endSocket: jest.fn(), leaveRoom: mockLeaveRoom, gameCode: mockGameCode, setGameCode: jest.fn(),
    setPlayersProvider: jest.fn(), socket: mockSocket, username: "alice", setRoundsOfGame: jest.fn(), roundsOfGame: 10,
    plantedPhotoUri: null, setPlantedPhotoUri: jest.fn(), plantPhoto: jest.fn(), saveRejoinToken: jest.fn(),
    getRejoinToken: async () => "tok-123", clearRejoinToken: jest.fn(),
    takeNewRoomRequest: () => true, setHomeNotice: jest.fn(), markRoomExit: jest.fn(),
  }),
}));
jest.mock("../src/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../src/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: jest.fn(async () => ({ status: "ok", limited: false, canAskAgain: true })),
    selectMorePhotos: jest.fn(async () => {}),
    onGalleryChange: jest.fn(() => () => {}),
  }),
}));
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("@react-native-vector-icons/ionicons/static", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/src/components/CloseButton", () => () => null);
jest.mock("@/src/components/AnimatedDot", () => () => null);
jest.mock("@/src/components/modals/AlertModal", () => () => null);
jest.mock("@/src/components/SuccessAlert", () => "SuccessAlert");

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const find = (root: ReactTestInstance, id: string) => root.findAll((n) => n.props.testID === id, { deep: true });
const has = (root: ReactTestInstance, id: string) => find(root, id).length > 0;
const pressable = (root: ReactTestInstance, id: string) => {
  const target = find(root, id).filter((n) => typeof n.props.onPress === "function").pop();
  if (!target) throw new Error(`nothing pressable with testID ${id}`);
  return target;
};
const press = (root: ReactTestInstance, id: string) => act(() => pressable(root, id).props.onPress());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const bubbleAuthors = (root: ReactTestInstance) =>
  root.findAll((n) => typeof n.type !== "string" && typeof n.props.message === "string" && typeof n.props.username === "string")
    .map((n) => n.props.username);

const reports = () => mockSocket.emitted
  .filter(([event]) => event === "report-content")
  .map(([, payload, ack]) => ({ payload, ack: ack as (answer: unknown) => void }));

const BOB_SAYS = "you're the worst";

/** alice's lobby with bob and carol; bob said BOB_SAYS and alice answered */
async function mountLobby() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  const players = ["alice", "bob", "carol"].map((username, i) => ({ username, isHost: i === 0, connected: true }));
  act(() => mockSocket.fire("room-of-game", {
    success: true, room: { gameCode: mockGameCode, players, rounds: 10, started: false }, rejoinToken: "tok-123",
  }));
  act(() => mockSocket.fire("chat-message", { username: "bob", message: BOB_SAYS }));
  act(() => find(r.root, TEST_IDS.chatInput).find((n) => n.props.onChangeText)!.props.onChangeText("stop it"));
  press(r.root, TEST_IDS.chatSendButton);
  // The server acks my message once the room got it: only then is my bubble shown
  const [, , ackChat] = mockSocket.emitted.find(([event]) => event === "chat-message")!;
  await act(async () => { ackChat({ ok: true, message: "stop it" }); });
  return r;
}

describe("WaitingRoom: reporting a chat message (EXP-423)", () => {
  let r: TestRenderer.ReactTestRenderer;
  let testNumber = 0;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGameCode = `K7MQ${++testNumber}0`;
    mockSocket.reset();
    mockLeaveRoom.mockClear();
  });
  afterEach(() => {
    act(() => r.unmount());
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("another player's bubble has a report flag named for screen readers; my own has none", async () => {
    r = await mountLobby();
    expect(bubbleAuthors(r.root)).toEqual(["bob", "alice"]);
    expect(pressable(r.root, chatReportId("bob")).props.accessibilityLabel).toBe("Report message from bob");
    expect(has(r.root, chatReportId("alice"))).toBe(false);
  });

  it("reports the bubble by its author and text, and mutes bob at once: his bubbles go, the thanks says so", async () => {
    r = await mountLobby();
    press(r.root, chatReportId("bob"));
    expect(has(r.root, TEST_IDS.reportModal)).toBe(true);
    expect(bubbleAuthors(r.root)).toEqual(["bob", "alice"]); // not muted for opening the picker
    press(r.root, reportReasonId("harassment"));
    expect(reports().map((x) => x.payload)).toEqual([{ kind: "message", author: "bob", text: BOB_SAYS, reason: "harassment" }]);
    expect(bubbleAuthors(r.root)).toEqual(["alice"]);
    expect(pressable(r.root, lobbyMuteId("bob")).props.accessibilityLabel).toBe("Unmute bob");

    await act(async () => { reports()[0].ack({ ok: true }); });
    expect(textOf(find(r.root, TEST_IDS.reportThanks)[0])).toBe("Thanks, we'll review it");
    expect(textOf(find(r.root, TEST_IDS.reportMutedNotice)[0])).toBe("You muted bob");
    press(r.root, TEST_IDS.reportCloseButton);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
    // Still muted after the dialog, and his next messages don't show either
    act(() => mockSocket.fire("chat-message", { username: "bob", message: "again" }));
    expect(bubbleAuthors(r.root)).toEqual(["alice"]);
  });

  it("a report that fails or is refused still leaves bob muted, and says so", async () => {
    r = await mountLobby();
    press(r.root, chatReportId("bob"));
    press(r.root, reportReasonId("other"));
    await act(async () => { reports()[0].ack({ ok: false, reason: "not-found" }); });
    expect(has(r.root, TEST_IDS.reportRefused)).toBe(true);
    expect(textOf(find(r.root, TEST_IDS.reportMutedNotice)[0])).toBe("You muted bob");
    press(r.root, TEST_IDS.reportCloseButton);
    expect(bubbleAuthors(r.root)).toEqual(["alice"]);
  });

  it("unmuting bob from the player list after reporting him shows his bubbles again", async () => {
    r = await mountLobby();
    press(r.root, chatReportId("bob"));
    press(r.root, reportReasonId("other"));
    await act(async () => { reports()[0].ack({ ok: true }); });
    press(r.root, TEST_IDS.reportCloseButton);
    press(r.root, lobbyMuteId("bob"));
    act(() => mockSocket.fire("chat-message", { username: "bob", message: "sorry" }));
    expect(bubbleAuthors(r.root)).toEqual(["alice", "bob"]);
  });

  it("Android back closes the report dialog and stays in the room", async () => {
    r = await mountLobby();
    press(r.root, chatReportId("bob"));
    let consumed = false;
    act(() => { consumed = mockBack.handler!(); });
    expect(consumed).toBe(true);
    expect(has(r.root, TEST_IDS.reportModal)).toBe(false);
    expect(mockLeaveRoom).not.toHaveBeenCalled();
    // With no dialog open, back is the lobby's Exit again
    act(() => { mockBack.handler!(); });
    expect(mockLeaveRoom).toHaveBeenCalledTimes(1);
  });

  it("Cancel in the reason picker reports nothing and keeps the author unmuted", async () => {
    r = await mountLobby();
    press(r.root, chatReportId("bob"));
    press(r.root, TEST_IDS.reportCancelButton);
    expect(reports()).toEqual([]);
    expect(bubbleAuthors(r.root)).toEqual(["bob", "alice"]);
    expect(pressable(r.root, lobbyMuteId("bob")).props.accessibilityLabel).toBe("Mute bob");
  });
});
