import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import ChatMessage, { MESSAGE_MAX_LINES } from "../src/components/IngameComunication/ChatMessage";

// EXP-447: a chat bubble shows at most MESSAGE_MAX_LINES lines of the message, so one message (the server keeps at most
// 3 line breaks, but 100 characters still wrap) never covers the lobby's chat area for the 5 s it stays.

jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("react-native-vector-icons/FontAwesome", () => "Icon");

const LONG_MESSAGE = "1\n2\n3\n" + "palabra ".repeat(12);

function renderBubble(message: string) {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<ChatMessage username="bob" message={message} onAnimationEnd={() => {}} />); });
  return r;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("ChatMessage bubble (EXP-447)", () => {
  it(`cuts the message at ${MESSAGE_MAX_LINES} lines, ending in an ellipsis`, () => {
    const r = renderBubble(LONG_MESSAGE);
    const text = r.root.findAllByType(Text).find((n) => n.props.children === LONG_MESSAGE)!;
    expect(MESSAGE_MAX_LINES).toBe(4);
    expect(text.props.numberOfLines).toBe(MESSAGE_MAX_LINES);
    expect(text.props.ellipsizeMode ?? "tail").toBe("tail");
    act(() => r.unmount());
  });

  it("shows the author's name on a single line", () => {
    const r = renderBubble("hola");
    const name = r.root.findAllByType(Text).find((n) => n.props.children === "bob")!;
    expect(name.props.numberOfLines).toBe(1);
    act(() => r.unmount());
  });
});
