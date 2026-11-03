import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Keyboard, StyleSheet } from "react-native";
import { FakeSocket } from "../testUtils/fakeSocket";
import { TEST_IDS } from "../src/utils/testIds";
import { LobbyChatMessages } from "../src/components/LobbyChat";
import type { LobbyChat } from "../src/hooks/useLobbyChat";
// Loaded with the file (jest.mock calls below are hoisted above it), not inside a test
import WaitingRoom from "../app/screens/WaitingRoom";

// EXP-411: the lobby chat bubbles were an overlay pinned near the top of the screen, drawn over the "Room code" title,
// the code and its copy button for the 5 s a bubble stays, and pushed to the left. They now fill an area laid out
// between the code block and the chat input (not the player list alone, which the keyboard squeezes to nothing),
// stack up from the input with the newest last, are centred, and let taps through to the controls underneath.

const mockSocket = new FakeSocket();

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
    takeNewRoomRequest: () => true,
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
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");
jest.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
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

// FlatList and the bubbles' fade schedule timers: keep them on fake timers
beforeEach(() => {
  jest.useFakeTimers();
  mockSocket.reset();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ── Helpers ──────────────────────────────────────────────

const hostById = (root: ReactTestInstance, id: string) =>
  root.find((n) => n.props.testID === id && typeof n.type === "string");
const styleOf = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style) ?? {};

/** The node and its ancestors, nearest first */
const lineage = (n: ReactTestInstance): ReactTestInstance[] => {
  const chain: ReactTestInstance[] = [];
  for (let at: ReactTestInstance | null = n; at; at = at.parent) chain.push(at);
  return chain;
};

/**
 * Where two nodes branch apart: their nearest common host ancestor and, for each node, the child of that ancestor it
 * hangs from.
 */
const branchPoint = (a: ReactTestInstance, b: ReactTestInstance) => {
  const aLineage = lineage(a);
  const bLineage = lineage(b);
  const common = aLineage.find((n) => typeof n.type === "string" && bLineage.includes(n))!;
  const branchOf = (chain: ReactTestInstance[]) => chain[chain.indexOf(common) - 1];
  return { common, aBranch: branchOf(aLineage), bBranch: branchOf(bLineage) };
};

/** The host views a composite branch renders at its top (the branch itself when it is a host view) */
const hostTops = (n: ReactTestInstance): ReactTestInstance[] =>
  typeof n.type === "string" ? [n] : n.children.flatMap((c) => (typeof c === "string" ? [] : hostTops(c)));

/** iPhone SE keyboard with the suggestion bar: the worst case for room under the room code */
const KEYBOARD_HEIGHT = 260;
/** Android's minimum touch target (dp) */
const MIN_TOUCH_TARGET = 48;
const NEWEST_MESSAGE = { username: "carol", message: "¡ya estoy dentro!" };

/** The lobby with alice hosting bob and carol, and a bubble from each; `keyboardUp` mounts it with the keyboard open */
async function mountLobbyWithBubbles({ keyboardUp = false } = {}) {
  if (keyboardUp) {
    jest.spyOn(Keyboard, "isVisible").mockReturnValue(true);
    jest.spyOn(Keyboard, "metrics").mockReturnValue({ height: KEYBOARD_HEIGHT, width: 375, screenX: 0, screenY: 407 });
  }
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<WaitingRoom />); });
  await act(async () => { await Promise.resolve(); });
  const players = ["alice", "bob", "carol"].map((username, i) => ({ username, isHost: i === 0 }));
  act(() => mockSocket.fire("room-of-game", {
    success: true, room: { gameCode: "K7MQ4X", players, rounds: 10, started: false }, rejoinToken: "tok-123",
  }));
  act(() => mockSocket.fire("chat-message", { username: "bob", message: "hola, ¿cuál era el código?" }));
  act(() => mockSocket.fire("chat-message", NEWEST_MESSAGE));
  return r;
}

/** The chat footer's bottom padding, which follows the keyboard: the outermost padding under the chat input */
const footerPadding = (r: TestRenderer.ReactTestRenderer) => {
  const outermostFirst = lineage(hostById(r.root, TEST_IDS.chatInput)).reverse();
  const padded = outermostFirst.find((n) => typeof n.type === "string" && styleOf(n).paddingBottom !== undefined)!;
  const padding = styleOf(padded).paddingBottom as unknown;
  return typeof padding === "number" ? padding : (padding as { __getValue: () => number }).__getValue();
};

/** The nearest host view holding `n` */
const hostParent = (n: ReactTestInstance) => lineage(n).slice(1).find((a) => typeof a.type === "string")!;

/** The testIDs inside a node */
const idsIn = (n: ReactTestInstance) =>
  new Set(n.findAll((c) => typeof c.props.testID === "string").map((c) => c.props.testID as string));

/** `child`, a host view, takes its own place in `parent`'s top-to-bottom column, before or after its siblings */
const expectInColumnFlow = (parent: ReactTestInstance, child: ReactTestInstance) => {
  expect(styleOf(parent).flexDirection ?? "column").toBe("column");
  for (const top of hostTops(child)) expect(styleOf(top).position).not.toBe("absolute");
};

// ── Placement in the lobby ───────────────────────────────

describe.each([
  ["with the keyboard down", false],
  ["with the keyboard up (the player list squeezed to nothing)", true],
])("WaitingRoom: chat bubbles stay off the room code, %s (EXP-411)", (_label, keyboardUp) => {
  afterEach(() => {
    (Keyboard.isVisible as jest.Mock).mockRestore?.();
    (Keyboard.metrics as jest.Mock).mockRestore?.();
  });

  it("follows the keyboard in the footer, as the lobby does on a phone", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    expect(footerPadding(r)).toBe(keyboardUp ? KEYBOARD_HEIGHT : 0);
    act(() => r.unmount());
  });

  it("lays the bubbles' area out in the column under the code block, not as an overlay over the screen", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    const chat = hostById(r.root, TEST_IDS.lobbyChatMessages);
    const codeBlock = hostById(r.root, TEST_IDS.lobbyCodeBlock);
    const { common, aBranch: areaBranch, bBranch: codeBranch } = branchPoint(chat, codeBlock);
    // A sibling after the code block in its column, in the flow, so it starts below the code block...
    expectInColumnFlow(common, areaBranch);
    expect(common.children.indexOf(areaBranch)).toBeGreaterThan(common.children.indexOf(codeBranch));
    // ...and holding none of it
    const inArea = idsIn(areaBranch);
    for (const id of [TEST_IDS.lobbyCodeBlock, TEST_IDS.lobbyGameCode, TEST_IDS.copyCodeButton, TEST_IDS.shareCodeButton]) {
      expect(inArea.has(id)).toBe(false);
    }
    act(() => r.unmount());
  });

  it("ends the area where the chat input starts", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    const chat = hostById(r.root, TEST_IDS.lobbyChatMessages);
    const input = hostById(r.root, TEST_IDS.chatInput);
    const { common, aBranch: areaBranch, bBranch: footerBranch } = branchPoint(chat, input);
    expectInColumnFlow(common, areaBranch);
    expect(common.children.indexOf(areaBranch)).toBeLessThan(common.children.indexOf(footerBranch));
    act(() => r.unmount());
  });

  it("fills everything between the two, not the player list alone, bounded top and bottom", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    const chat = hostById(r.root, TEST_IDS.lobbyChatMessages);
    // Its area holds the plant button, the player list and the host's Start: it doesn't shrink with the list
    const inArea = idsIn(hostParent(chat));
    const missing = [TEST_IDS.plantPhotoButton, "lobby-player-alice", TEST_IDS.startGameButton].filter((id) => !inArea.has(id));
    expect(missing).toEqual([]);
    // ...and the bubbles fill exactly that area, cutting off what doesn't fit
    expect(styleOf(chat)).toEqual(expect.objectContaining({ position: "absolute", top: 0, bottom: 0, overflow: "hidden" }));
    act(() => r.unmount());
  });

  it("stacks the bubbles up from the input, the newest last, so the newest is the one that always shows", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    const chat = hostById(r.root, TEST_IDS.lobbyChatMessages);
    expect(styleOf(chat).justifyContent).toBe("flex-end");
    const bubbles = chat.findAll((n) => typeof n.type !== "string" && typeof n.props.message === "string");
    expect(bubbles.map((n) => n.props.username)).toEqual(["bob", NEWEST_MESSAGE.username]);
    act(() => r.unmount());
  });

  it("lets taps through the bubbles to the controls underneath, except on another player's report flag (EXP-423)", async () => {
    const r = await mountLobbyWithBubbles({ keyboardUp });
    const chat = hostById(r.root, TEST_IDS.lobbyChatMessages);
    expect(styleOf(chat).pointerEvents).toBe("box-none");
    // Nothing in the bubbles but their report flags takes a touch: every host node outside a flag passes taps on
    // ('box-none') or sits in a view that never takes one ('none'), its texts included (a Text is a hit target)
    const flags = chat.findAll((n) => typeof n.type === "string" && /^chat-report-/.test(n.props.testID ?? ""));
    expect(flags.map((n) => n.props.testID)).toEqual(["chat-report-bob", `chat-report-${NEWEST_MESSAGE.username}`]);
    const inFlag = (n: ReactTestInstance) => lineage(n).some((a) => flags.includes(a));
    /** The pointerEvents the node itself has, or 'none' when a view it sits in (up to the chat area) has 'none' */
    const touchMode = (n: ReactTestInstance) => {
      const upToChat = lineage(n).slice(0, lineage(n).indexOf(chat));
      if (upToChat.some((a) => typeof a.type === "string" && styleOf(a).pointerEvents === "none")) return "none";
      return styleOf(n).pointerEvents ?? n.props.pointerEvents ?? "auto";
    };
    const hosts = chat.findAll((n) => typeof n.type === "string" && n !== chat && !inFlag(n));
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.filter((n) => !["none", "box-none"].includes(touchMode(n))).map((n) => n.type)).toEqual([]);
    // The texts themselves are under a 'none' view
    const texts = hosts.filter((n) => (n.type as unknown) === "Text");
    expect(texts.length).toBe(4);
    expect(texts.every((n) => touchMode(n) === "none")).toBe(true);
    // Each flag is a box of its own of at least 48 dp, laid out inside its bubble (Android drops touches outside a
    // view's parent: a hitSlop past it would not count), in a bubble at least as tall
    for (const flag of flags) {
      const box = styleOf(flag);
      expect(flag.props.hitSlop).toBeUndefined();
      expect(box).toEqual(expect.objectContaining({ position: "absolute", top: 0, right: 0, bottom: 0 }));
      expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(box.minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      const bubble = hostParent(flag);
      expect(hostParent(bubble)).toBe(chat);
      expect(styleOf(bubble).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(styleOf(bubble).paddingRight).toBeGreaterThanOrEqual(box.width as number);
    }
    act(() => r.unmount());
  });
});

// ── Centring ─────────────────────────────────────────────

describe("LobbyChatMessages: centred bubbles (EXP-411)", () => {
  const chatWith = (messages: LobbyChat["messages"]): LobbyChat => ({
    messages, send: jest.fn(() => true), receive: jest.fn(), remove: jest.fn(), clear: jest.fn(),
  });

  it("spans its area and centres every bubble in it, with no offset to one side", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <LobbyChatMessages myUsername="alice" onReport={jest.fn()} chat={chatWith([
          { id: "1", username: "bob", message: "hola" },
          { id: "2", username: "carol", message: "un mensaje bastante más largo para ver el ancho" },
        ])} />
      );
    });
    const container = hostById(r.root, TEST_IDS.lobbyChatMessages);
    expect(styleOf(container)).toEqual(expect.objectContaining({ position: "absolute", left: 0, right: 0, alignItems: "center" }));

    const bubbles = container.children.filter((c): c is ReactTestInstance => typeof c !== "string").flatMap(hostTops);
    expect(bubbles.length).toBe(2);
    for (const bubble of bubbles) {
      const style = styleOf(bubble);
      expect(style.alignSelf ?? "center").toBe("center");
      expect(style.marginLeft ?? 0).toBe(style.marginRight ?? 0);
      expect(style.marginHorizontal ?? 0).toBe(0);
    }
    act(() => r.unmount());
  });
});

// ── Readability over the controls (EXP-416) ──────────────

describe("LobbyChatMessages: bubbles readable over the controls (EXP-416)", () => {
  /** A bubble lets this much of the Start button, the rounds pill or «Waiting…» under it show through, at most */
  const MAX_SHOW_THROUGH = 0.1;

  /** The alpha of an `rgba(...)`/`rgb(...)`/`#rrggbb[aa]` colour, 1 when it has none */
  const alphaOf = (color: string): number => {
    const rgba = /^rgba?\(([^)]+)\)$/.exec(color);
    if (rgba) {
      const parts = rgba[1].split(",").map((p) => p.trim());
      return parts.length === 4 ? Number(parts[3]) : 1;
    }
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
    if (hex) return hex[2] ? parseInt(hex[2], 16) / 255 : 1;
    throw new Error(`unexpected colour ${color}`);
  };

  it("draws each bubble on a near-opaque background with an edge that sets it apart, and still lets taps through", () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(
        <LobbyChatMessages myUsername="alice" onReport={jest.fn()} chat={{
          messages: [{ id: "1", username: "chatter", message: "hola" }],
          send: jest.fn(() => true), receive: jest.fn(), remove: jest.fn(), clear: jest.fn(),
        }} />
      );
    });
    const container = hostById(r.root, TEST_IDS.lobbyChatMessages);
    const [bubble] = container.children.filter((c): c is ReactTestInstance => typeof c !== "string").flatMap(hostTops);
    const style = styleOf(bubble);

    expect(alphaOf(String(style.backgroundColor))).toBeGreaterThanOrEqual(1 - MAX_SHOW_THROUGH);
    expect(style.borderWidth ?? 0).toBeGreaterThan(0);
    expect(style.borderColor).toBeDefined();
    expect(styleOf(container).pointerEvents).toBe("box-none");
    expect(style.pointerEvents).toBe("box-none");
    act(() => r.unmount());
  });
});
