import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text } from "react-native";
import AlertModal from "../src/components/modals/AlertModal";
import { splitHighlightTemplate } from "../src/utils/highlightTemplate";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-381: the kick confirmation was "Are you sure you want to remove" + " @name", with no closing "?". The message is
// now a template whose {name} the dialog paints in red, and Spanish players read «anfitrión», never «host».

jest.mock("react-native-animatable", () => ({ View: "AnimatableView" }));

const renderAlert = (message: string, highlightedText?: string) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <AlertModal visible title="t" message={message} highlightedText={highlightedText} onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
  });
  return r;
};

// The message is the outermost Text holding the highlighted one
const messageText = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).find((n) => n.findAllByType(Text).length > 1)!;
const flatText = (children: unknown): string =>
  React.Children.toArray(children as React.ReactNode)
    .map((c) => (typeof c === "string" ? c : flatText((c as React.ReactElement<{ children?: unknown }>).props.children)))
    .join("");

describe("splitHighlightTemplate (EXP-381)", () => {
  it("cuts the template around {name}", () => {
    expect(splitHighlightTemplate("Remove {name} from the room?", "@bob")).toEqual({
      before: "Remove ",
      highlight: "@bob",
      after: " from the room?",
    });
  });

  it("keeps a name with $ replacement patterns literal", () => {
    const { before, highlight, after } = splitHighlightTemplate(en.areYouSureRemove, "@a$&b$'c$`");
    expect(before + highlight + after).toBe("Are you sure you want to remove @a$&b$'c$` from the room?");
  });

  it("without a placeholder, the highlighted text follows the message", () => {
    expect(splitHighlightTemplate("Sure?", "@bob")).toEqual({ before: "Sure? ", highlight: "@bob", after: "" });
  });
});

describe("AlertModal highlighted text (EXP-381)", () => {
  it("paints the name in red in the middle of the sentence, closing question mark included", () => {
    const r = renderAlert(es.areYouSureRemove, "@$&bob");
    const message = messageText(r);
    expect(flatText(message.props.children)).toBe("¿Seguro que quieres expulsar a @$&bob de la sala?");
    const highlighted = message.findAllByType(Text).filter((n) => n !== message);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].props.children).toBe("@$&bob");
    act(() => r.unmount());
  });

  it("a plain message has no highlighted part", () => {
    const r = renderAlert("Just a message");
    expect(r.root.findAllByType(Text).some((n) => n.props.children === "Just a message")).toBe(true);
    act(() => r.unmount());
  });
});

describe("lobby texts (EXP-381)", () => {
  it("guests wait for the host, in grammatical English and with «anfitrión» in Spanish", () => {
    expect(en.waitingHost).toBe("Waiting for the host");
    expect(es.waitingHost).toBe("Esperando al anfitrión");
  });

  it("Spanish players never read «host»", () => {
    const withHost = Object.entries(es).filter(([, v]) => typeof v === "string" && /\bhost\b/i.test(v));
    expect(withHost).toEqual([]);
  });

  it("both kick confirmations carry the {name} placeholder and end in a question mark", () => {
    for (const { areYouSureRemove } of [en, es]) {
      expect(areYouSureRemove.split("{name}")).toHaveLength(2);
      expect(areYouSureRemove.endsWith("?")).toBe(true);
    }
  });
});
