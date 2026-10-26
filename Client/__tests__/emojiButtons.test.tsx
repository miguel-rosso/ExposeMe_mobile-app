import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Text } from "react-native";
import EmojisButton from "../app/components/IngameComunication/EmojisButtons";
import { REACTION_EMOJIS } from "../app/utils/reactions";
import { emojiButtonId } from "../app/utils/testIds";

// EXP-204: every button of the in-game emoji bar has a stable ASCII testID, so Maestro flows can send reactions

const mockSocket = { connected: true, emit: jest.fn() };
jest.mock("../app/providers/GameContext", () => ({ useGameContext: () => ({ socket: mockSocket }) }));

const button = (root: ReactTestInstance, index: number) =>
  root.findAll((n) => n.props.testID === emojiButtonId(index) && typeof n.props.onPress === "function")[0];

describe("EmojisButton testIDs (EXP-204)", () => {
  let r: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    mockSocket.emit.mockClear();
    mockSocket.connected = true;
    act(() => { r = TestRenderer.create(<EmojisButton />); });
  });
  afterEach(() => act(() => r.unmount()));

  it("each emoji button exposes its own testID and shows its emoji", () => {
    REACTION_EMOJIS.forEach((emoji, index) => {
      const b = button(r.root, index);
      expect(b).toBeDefined();
      expect(b.findByType(Text).props.children).toBe(emoji);
    });
    expect(new Set(REACTION_EMOJIS.map((_, i) => emojiButtonId(i))).size).toBe(REACTION_EMOJIS.length);
    expect(emojiButtonId(0)).toMatch(/^emoji-button-\d+$/);
  });

  it("pressing a button by its testID sends that emoji", () => {
    act(() => button(r.root, 4).props.onPress());
    expect(mockSocket.emit).toHaveBeenCalledWith("emoji-reaction", { emoji: REACTION_EMOJIS[4] });
  });

  // EXP-274: socket.io would buffer it and flush it on the new socket before the rejoin, where the server drops it
  it("offline, a press sends nothing and spends no cooldown", () => {
    mockSocket.connected = false;
    act(() => button(r.root, 1).props.onPress());
    expect(mockSocket.emit).not.toHaveBeenCalled();
    mockSocket.connected = true;
    act(() => button(r.root, 1).props.onPress());
    expect(mockSocket.emit).toHaveBeenCalledWith("emoji-reaction", { emoji: REACTION_EMOJIS[1] });
  });
});
