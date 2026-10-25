import React from "react";
import TestRenderer, { act, ReactTestInstance } from "react-test-renderer";
import PausedModal from "../app/components/modals/PausedModal";
import { TEST_IDS } from "../app/utils/testIds";
import en from "../app/i18n/en";
import es from "../app/i18n/es";

// EXP-084 / DEC-012: each pause has its own 5:00 countdown and there are at most 3 per game.
// The modal shows "Pause N of M" and, on the last one, that the game ends if nobody comes back.

let mockT: typeof en | typeof es = en;
jest.mock("../app/i18n", () => ({ useI18n: () => ({ t: mockT }) }));

const text = (root: ReactTestInstance, id: string) => {
  const found = root.findAll((n) => n.props.testID === id && typeof n.type === "string", { deep: true });
  return found.length ? [found[0].props.children].flat().join("") : null;
};

const render = (props: React.ComponentProps<typeof PausedModal>) => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<PausedModal {...props} />); });
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

  it("renders nothing when not paused", () => {
    const r = render({ endsAt: null, pause: 0, maxPauses: 3 });
    expect(r.toJSON()).toBeNull();
    act(() => r.unmount());
  });
});
