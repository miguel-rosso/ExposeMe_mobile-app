import React from "react";
import { StyleSheet } from "react-native";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { ScoreRound } from "../src/models/interfaces";
import { scoreMuteId, scoreRankId, scoreRemoveId } from "../src/utils/testIds";
import ScoreModal from "../src/components/modals/ScoreModal";

// EXP-459: the scoreboard rows spread their contents (justify-between), so the own row (no mute button) pushed its
// points to the right edge, and on the other rows the points moved with the name's length. Every row must have the
// same right-hand columns: the points, then one fixed slot per row action, empty where that row has none.

jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: require("../src/i18n/en").default }) }));
jest.mock("@react-native-vector-icons/fontawesome/static", () => "Icon");
jest.mock("../src/hooks/useReduceMotion", () => ({ useReduceMotion: () => true }));

const ME = "me";
const NAMES = [ME, "a", "averyveryverylon", "bot3"];
const scores: ScoreRound[] = NAMES.map((username, i) => ({
  username, points: [3, 12, 0, 7][i], isHost: username === ME, lastAnswerCorrect: i % 2 === 0, lastGuess: "a",
}));

const render = (el: React.ReactElement) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(el); });
  return r;
};
const hostNode = (root: ReactTestInstance, id: string) =>
  root.find((n) => n.props.testID === id && typeof n.type === "string");
/** The nearest host (native) elements under `n`, looking through composite wrappers */
const hostChildren = (n: ReactTestInstance): ReactTestInstance[] =>
  n.children.flatMap((c) => {
    if (typeof c === "string") return [];
    return typeof c.type === "string" ? [c] : hostChildren(c);
  });

/** The row's part right of the rank badge: the name block, then the right-hand columns */
const rowContent = (root: ReactTestInstance, username: string) => {
  let node = hostNode(root, scoreRankId(username)).parent;
  // Up to the host View holding the rank badge and the row's content
  while (node && !(typeof node.type === "string" && hostChildren(node).length === 2)) node = node.parent;
  if (!node) throw new Error(`no row for ${username}`);
  return hostChildren(node)[1];
};
/** Each column's flattened style, the name block (first) left out: it takes whatever space is left */
const columnStyles = (root: ReactTestInstance, username: string) =>
  hostChildren(rowContent(root, username)).slice(1).map((c) => StyleSheet.flatten(c.props.style));

const expectSameColumns = (root: ReactTestInstance) => {
  const mine = columnStyles(root, ME);
  for (const name of NAMES) expect(columnStyles(root, name)).toEqual(mine);
  // Nothing spreads the row: the name block takes the free space, so the columns stay at the end
  for (const name of NAMES) {
    const content = rowContent(root, name);
    expect(StyleSheet.flatten(content.props.style).justifyContent).toBeUndefined();
    expect(StyleSheet.flatten(hostChildren(content)[0].props.style).flexGrow).toBe(1);
  }
};

describe("Scoreboard points column (EXP-459)", () => {
  it("lines the points up on the own row (no mute button) and the others", () => {
    const r = render(
      <ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 5 }} correctAnswer=""
        myUsername={ME} onToggleMute={jest.fn()} />
    );
    expect(r.root.findAll((n) => n.props.testID === scoreMuteId(ME))).toHaveLength(0);
    expect(hostNode(r.root, scoreMuteId("a"))).toBeDefined();
    expectSameColumns(r.root);
    act(() => r.unmount());
  });

  it("keeps them lined up for the host, whose remove button is only on the removable rows", () => {
    const r = render(
      <ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 5 }} correctAnswer=""
        myUsername={ME} onToggleMute={jest.fn()} onRemovePlayer={jest.fn()} removable={new Set(["bot3"])} />
    );
    expect(hostNode(r.root, scoreRemoveId("bot3"))).toBeDefined();
    expect(r.root.findAll((n) => n.props.testID === scoreRemoveId("a"))).toHaveLength(0);
    expectSameColumns(r.root);
    act(() => r.unmount());
  });

  it("right-aligns the points so short and long scores end at the same edge", () => {
    const r = render(
      <ScoreModal visible scoreRound={scores} rounds={{ round: 1, roundsOfGame: 5 }} correctAnswer="" myUsername={ME} />
    );
    const points = columnStyles(r.root, "a")[0];
    expect(points.textAlign).toBe("right");
    expect(points.minWidth).toBeGreaterThan(0);
    expectSameColumns(r.root);
    act(() => r.unmount());
  });
});
