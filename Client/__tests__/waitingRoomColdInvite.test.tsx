import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";
import { GameProvider, useGameContext } from "../app/providers/GameContext";
import { TEST_IDS } from "../app/utils/testIds";
import { inviteNameInput, pressInviteJoin, showsInviteDialog } from "../testUtils/inviteConfirm";

// EXP-334: an invite link that cold-starts the app mounts the waiting room (home is only an unfocused screen under it),
// with the real GameProvider and nothing in memory. Its invite dialog (EXP-347) must offer the name saved on this
// device, once read, and without a saved name ask for one right there instead of loading forever.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// ── Fake socket.io client ──

type Handler = (...args: any[]) => void;
class MockSocket {
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];
  connected = false;
  active = true;
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn: Handler) {
    this.handlers.get(ev)?.delete(fn);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  connect() {
    return this;
  }
  disconnect() {
    this.connected = false;
    this.active = false;
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
const mockSockets: MockSocket[] = [];
jest.mock("socket.io-client", () => ({
  io: () => {
    const s = new MockSocket();
    mockSockets.push(s);
    return s;
  },
}));

// ── Screen dependencies ──

const LINKED_ROOM = "XYZ789";
const INVITE_LINK_PARAMS = { code: "xyz789" }; // any case, like the shared link
let mockLinkParams: { code?: string } = INVITE_LINK_PARAMS;
const mockDismissTo = jest.fn();
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, dismissTo: mockDismissTo }),
  useLocalSearchParams: () => mockLinkParams,
}));
jest.mock("../app/providers/BackgroundContext", () => ({ useBackgroundContext: () => ({ backgroundImage: null }) }));
jest.mock("../app/providers/PhotoContext", () => ({
  usePhotoContext: () => ({
    requestGalleryPermission: jest.fn(),
    checkGalleryAccess: async () => ({ status: "ok", limited: false, canAskAgain: true }),
    selectMorePhotos: jest.fn(async () => {}),
  }),
}));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
jest.mock("react-native-animatable", () => ({ View: "AnimatableView", initializeRegistryWithDefinitions: jest.fn() }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
jest.mock("@/app/components/CloseButton", () => () => null);
jest.mock("@/app/components/AnimatedDot", () => () => null);
jest.mock("@/app/components/modals/AlertModal", () => () => null);
jest.mock("@/app/components/IngameComunication/ChatMessage", () => "ChatMessage");
jest.mock("@/app/components/SuccessAlert", () => () => null);

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

// Unmounted after each test, so a failing test never leaves a provider running into the next one
let mounted: TestRenderer.ReactTestRenderer | null = null;
/** The app cold-started by the invite link: a new GameProvider with the waiting room as the focused screen. */
const openColdInviteLink = async () => {
  await act(async () => {
    mounted = TestRenderer.create(<GameProvider><WaitingRoom /><Probe /></GameProvider>);
  });
  await flush();
  return mounted!;
};

const connectSocket = async () => {
  const socket = mockSockets.at(-1)!;
  socket.connected = true;
  await act(async () => { socket.fire("connect"); });
  await flush();
  return socket;
};

const joins = (socket: MockSocket) =>
  socket.emitted.filter(([ev]) => ev === "join-create-game").map(([, data]) => data);
const showsLoading = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll((n) => n.props.testID === TEST_IDS.lobbyLoading).length > 0;

/** AsyncStorage.getItem answers for the saved name only when `release()` is called (a slow storage read). */
const storageGetItem = AsyncStorage.getItem as jest.Mock;
const storageRead = storageGetItem.getMockImplementation()!;
const holdStoredNameRead = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  storageGetItem.mockImplementation(async (key: string) => {
    if (key === "username") await released;
    return storageRead(key);
  });
  return async () => {
    release();
    await flush();
  };
};

// FlatList schedules cell updates on timers: keep them on fake timers
beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  mockSockets.length = 0;
  mockDismissTo.mockClear();
  mockReplace.mockClear();
  mockLinkParams = INVITE_LINK_PARAMS;
});
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  jest.clearAllTimers();
  jest.useRealTimers();
  storageGetItem.mockImplementation(storageRead);
});

describe("WaitingRoom opened by a cold invite link (EXP-334)", () => {
  it("joins the linked room with the saved name (normalized) and keeps the stored token for it", async () => {
    await AsyncStorage.setItem("username", " bob ");
    await AsyncStorage.setItem("rejoinToken", JSON.stringify({ gameCode: LINKED_ROOM, username: "bob", token: "tok-linked" }));
    const r = await openColdInviteLink();
    expect(inviteNameInput(r).props.value).toBe("bob");
    await pressInviteJoin(r);

    const socket = await connectSocket();
    expect(joins(socket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob", rejoinToken: "tok-linked" }]);
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("asks only once the saved name is read, with that name filled in", async () => {
    await AsyncStorage.setItem("username", "bob");
    const releaseStoredName = holdStoredNameRead();
    const r = await openColdInviteLink();
    expect(showsInviteDialog(r)).toBe(false);
    expect(showsLoading(r)).toBe(true);
    expect(mockDismissTo).not.toHaveBeenCalled(); // not read yet: no name is not the same as none saved

    await releaseStoredName();
    expect(inviteNameInput(r).props.value).toBe("bob");
    await pressInviteJoin(r);
    const socket = await connectSocket();
    expect(joins(socket)).toEqual([{ gameCode: LINKED_ROOM, username: "bob" }]);
  });

  it.each([
    ["no name saved (fresh install)", null],
    ["a blank saved name", "   "],
  ])("with %s asks for one in the dialog instead of sending the player home", async (_, stored) => {
    if (stored !== null) await AsyncStorage.setItem("username", stored);
    const r = await openColdInviteLink();

    expect(showsInviteDialog(r)).toBe(true);
    expect(inviteNameInput(r).props.value).toBe("");
    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(mockSockets).toHaveLength(0); // nothing joins until Join
  });
});

describe("WaitingRoom opened without a room code (EXP-334)", () => {
  // Only home's Create game asks the server for a new room (join-create-game without a code)
  it.each([
    ["a link without a code", {}],
    ["a link with a malformed code", { code: "12345O" }],
  ])("from %s goes home and joins nothing, not even a new room", async (_, params) => {
    await AsyncStorage.setItem("username", "bob");
    mockLinkParams = params;
    await openColdInviteLink();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(0); // never even connected
  });

  it("from home's Create game asks the server for a new room", async () => {
    await AsyncStorage.setItem("username", "bob");
    mockLinkParams = {};
    await act(async () => { mounted = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    await flush();
    act(() => ctx.requestNewRoom());
    await act(async () => { mounted!.update(<GameProvider><WaitingRoom /><Probe /></GameProvider>); });
    await flush();

    const socket = await connectSocket();
    expect(joins(socket)).toEqual([{ gameCode: null, username: "bob" }]);
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it("asks for a new room once: a later waiting room without a code goes home", async () => {
    await AsyncStorage.setItem("username", "bob");
    mockLinkParams = {};
    await act(async () => { mounted = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    await flush();
    act(() => ctx.requestNewRoom());
    expect(ctx.takeNewRoomRequest()).toBe(true); // the waiting room Create opened took it
    await act(async () => { mounted!.update(<GameProvider><WaitingRoom /><Probe /></GameProvider>); });
    await flush();

    expect(mockDismissTo).toHaveBeenCalledWith("/");
    expect(mockSockets).toHaveLength(0);
  });
});

describe("GameProvider saved name (EXP-334, EXP-263)", () => {
  it("is loaded at app start, normalized (older versions saved it with stray spaces)", async () => {
    await AsyncStorage.setItem("username", "Ana  María ");
    act(() => { mounted = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    expect(ctx.usernameLoaded).toBe(false);
    expect(ctx.username).toBeNull();
    await flush();
    expect(ctx.usernameLoaded).toBe(true);
    expect(ctx.username).toBe("Ana María");
  });

  it("does not overwrite a name typed before the saved one was read", async () => {
    await AsyncStorage.setItem("username", "bob");
    const releaseStoredName = holdStoredNameRead();
    act(() => { mounted = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    act(() => ctx.setUsername("alice"));
    await releaseStoredName();
    expect(ctx.usernameLoaded).toBe(true);
    expect(ctx.username).toBe("alice");
  });
});
