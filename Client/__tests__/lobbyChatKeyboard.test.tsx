import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Keyboard } from "react-native";
import { LobbyChatFooter } from "../app/components/LobbyChat";
import type { LobbyChat } from "../app/hooks/useLobbyChat";
import { TEST_IDS } from "../app/utils/testIds";

// EXP-378: the keyboard's return key sends the lobby chat message and keeps the keyboard up to go on chatting; with
// nothing typed it closes the keyboard. The send button closes it once the message is out. Those are the lobby's ways
// back to the room on iOS. A refused send leaves the keyboard up.

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: require("../app/i18n/en").default }) }));

/** A chat whose send goes out (true) or is refused (false: cooldown, offline) */
const fakeChat = (draft: string, sendGoesOut = true): LobbyChat => ({
  draft,
  setDraft: jest.fn(),
  messages: [],
  send: jest.fn(() => sendGoesOut),
  receive: jest.fn(),
  remove: jest.fn(),
  clear: jest.fn(),
});

let dismissKeyboard: jest.SpyInstance;
beforeEach(() => { dismissKeyboard = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {}); });
afterEach(() => dismissKeyboard.mockRestore());

const renderFooter = (chat: LobbyChat) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<LobbyChatFooter chat={chat} />); });
  return r;
};
const chatInput = (r: TestRenderer.ReactTestRenderer) =>
  r.root.find((n) => n.props.testID === TEST_IDS.chatInput && typeof n.props.onChangeText === "function");
const pressSend = (r: TestRenderer.ReactTestRenderer) =>
  act(() => {
    r.root.find((n) => n.props.testID === TEST_IDS.chatSendButton && typeof n.props.onPress === "function").props.onPress();
  });

describe("Lobby chat input and the keyboard (EXP-378)", () => {
  it("the return key, labelled Send, sends the draft and leaves the keyboard up", () => {
    const chat = fakeChat("hola");
    const r = renderFooter(chat);
    const input = chatInput(r);
    expect(input.props.returnKeyType).toBe("send");

    act(() => input.props.onSubmitEditing({ nativeEvent: { text: "hola" } }));
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(dismissKeyboard).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("the return key doesn't blur the input by itself", () => {
    const r = renderFooter(fakeChat("hola"));
    expect(chatInput(r).props.submitBehavior).toBe("submit");
    act(() => r.unmount());
  });

  it("the return key with nothing typed (or only spaces) closes the keyboard and sends nothing", () => {
    const chat = fakeChat("   ");
    const r = renderFooter(chat);
    const input = chatInput(r);
    expect(input.props.enablesReturnKeyAutomatically).toBeFalsy(); // never greyed out: it is the way to close
    act(() => input.props.onSubmitEditing({ nativeEvent: { text: "   " } }));
    expect(chat.send).not.toHaveBeenCalled();
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("the return key on a refused send (cooldown, offline) leaves the keyboard up", () => {
    const chat = fakeChat("hola", false);
    const r = renderFooter(chat);
    act(() => chatInput(r).props.onSubmitEditing({ nativeEvent: { text: "hola" } }));
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(dismissKeyboard).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("the send button closes the keyboard once the message is out", () => {
    const chat = fakeChat("hola");
    const r = renderFooter(chat);
    pressSend(r);
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(dismissKeyboard).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it("a send the button can't make (cooldown, offline) leaves the keyboard up", () => {
    const chat = fakeChat("hola", false);
    const r = renderFooter(chat);
    pressSend(r);
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(dismissKeyboard).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
