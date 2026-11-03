import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import { Text } from "react-native";
import PausedModal from "../src/components/modals/PausedModal";
import { TEST_IDS } from "../src/utils/testIds";
import en from "../src/i18n/en";
import es from "../src/i18n/es";

// EXP-084 / DEC-012: each pause has its own 5:00 countdown and there are at most 3 per game.
// The modal shows "Pause N of M" and, on the last one, that the game ends if nobody comes back.

let mockT: typeof en | typeof es = en;
jest.mock("../src/i18n", () => ({ useI18n: () => ({ t: mockT }) }));

const text = (root: ReactTestInstance, id: string) => {
  const found = root.findAll((n) => n.props.testID === id && typeof n.type === "string", { deep: true });
  return found.length ? [found[0].props.children].flat().join("") : null;
};

type Props = React.ComponentProps<typeof PausedModal>;
const render = (props: Omit<Props, "onLeave" | "waitingFor"> & Partial<Pick<Props, "onLeave" | "waitingFor">>) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<PausedModal onLeave={jest.fn()} waitingFor={["carol"]} {...props} />); });
  return r;
};

describe("PausedModal", () => {
  beforeEach(() => { jest.useFakeTimers(); mockT = en; });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("shows which pause this is, without a warning while more pauses are left", () => {
    const r = render({ endsAt: Date.now() + 300_000, pause: 2, maxPauses: 3 });
    expect(text(r.root, TEST_IDS.pausedCountdown)).toBe("5:00");
    expect(text(r.root, TEST_IDS.pausedCounter)).toBe("Pause 2 of 3");
    expect(text(r.root, TEST_IDS.pausedLastWarning)).toBeNull();
    act(() => r.unmount());
  });

  it("on the last allowed pause warns that the game ends if nobody comes back (en/es)", () => {
    let r = render({ endsAt: Date.now() + 300_000, pause: 3, maxPauses: 3 });
    expect(text(r.root, TEST_IDS.pausedCounter)).toBe("Pause 3 of 3");
    expect(text(r.root, TEST_IDS.pausedLastWarning)).toBe(en.lastPauseWarning);
    act(() => r.unmount());

    mockT = es;
    r = render({ endsAt: Date.now() + 300_000, pause: 3, maxPauses: 3 });
    expect(text(r.root, TEST_IDS.pausedCounter)).toBe("Pausa 3 de 3");
    expect(text(r.root, TEST_IDS.pausedLastWarning)).toBe(es.lastPauseWarning);
    expect(es.lastPauseWarning).toMatch(/terminar/);
    expect(en.lastPauseWarning).toMatch(/end/);
    act(() => r.unmount());
  });

  // EXP-377: whoever doesn't want to wait can leave from the pause (the game screen asks first)
  it("has an Exit that asks to leave the game (en/es)", () => {
    const onLeave = jest.fn();
    const leaveButton = (r: TestRenderer.ReactTestRenderer) =>
      r.root.find((n) => n.props.testID === TEST_IDS.pausedLeaveButton && typeof n.props.onPress === "function");
    const label = (r: TestRenderer.ReactTestRenderer) => leaveButton(r).findByType(Text).props.children;

    let r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3, onLeave });
    expect(label(r)).toBe("Leave game");
    act(() => leaveButton(r).props.onPress());
    expect(onLeave).toHaveBeenCalledTimes(1);
    act(() => r.unmount());

    mockT = es;
    r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3 });
    expect(label(r)).toBe("Salir de la partida");
    act(() => r.unmount());
  });

  // EXP-380: the modal says who it waits for, so the others know whom to call
  it("names the awaited players (en/es), and falls back to a generic line without names", () => {
    const allTexts = (r: TestRenderer.ReactTestRenderer) =>
      r.root.findAllByType(Text).map((n) => [n.props.children].flat().join(""));
    let r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3, waitingFor: ["Ana", "Luis"] });
    expect(allTexts(r)).toContain("Waiting for Ana and Luis…");
    expect(allTexts(r)).not.toContain(en.waitingPlayersReturn);
    act(() => r.unmount());

    mockT = es;
    r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3, waitingFor: ["Ana", "Luis"] });
    expect(allTexts(r)).toContain("Esperando a Ana y Luis…");
    act(() => r.unmount());

    r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3, waitingFor: [] });
    expect(allTexts(r)).toContain(es.waitingPlayersReturn);
    act(() => r.unmount());
  });

  it("caps the awaited players' line so long names can't push the countdown and Exit off the modal", () => {
    const longNames = ["W".repeat(15), "M".repeat(15), "Q".repeat(15), "Z".repeat(15)];
    const r = render({ endsAt: Date.now() + 300_000, pause: 1, maxPauses: 3, waitingFor: longNames });
    const line = r.root.find((n) => n.props.testID === TEST_IDS.pausedWaitingFor && typeof n.type === "string");
    expect(text(r.root, TEST_IDS.pausedWaitingFor)).toBe(`Waiting for ${longNames[0]}, ${longNames[1]} and 2 more…`);
    expect(line.props.numberOfLines).toBeGreaterThan(0);
    expect(line.props.ellipsizeMode).toBe("tail");
    act(() => r.unmount());
  });

  it("renders nothing when not paused", () => {
    const r = render({ endsAt: null, pause: 0, maxPauses: 3 });
    expect(r.toJSON()).toBeNull();
    act(() => r.unmount());
  });
});
