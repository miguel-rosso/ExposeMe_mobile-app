import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Socket } from "socket.io-client";
import { MarkPhaseHandled, useQaRenderAck } from "../app/hooks/useQaRenderAck";
import type { ServerPhase } from "../app/models/interfaces";

// EXP-012: QA builds (development bundle + EXPO_PUBLIC_QA=1) send qa-ack once per rendered phase start; other builds
// never send it.

interface Props { phase: ServerPhase | null; round: number; phaseKey: number }

const socket = { emit: jest.fn() };
const Probe = ({ phase, round, phaseKey }: Props) => {
  useQaRenderAck(socket as unknown as Socket, phase, round, phaseKey);
  return null;
};

const acks = () => socket.emit.mock.calls.filter(([ev]) => ev === "qa-ack").map(([, data]) => data);

/** Renders the probe through `steps` (each a re-render with new props). */
function renderSteps(steps: Props[]): void {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<Probe {...steps[0]} />); });
  steps.slice(1).forEach((p) => act(() => r.update(<Probe {...p} />)));
  act(() => r.unmount());
}

const PHASES: Props[] = [
  { phase: null, round: 0, phaseKey: 0 }, // ready screen: nothing to ack
  { phase: "waiting-photo", round: 1, phaseKey: 1 },
  { phase: "waiting-photo", round: 1, phaseKey: 1 }, // re-render of the same phase
  { phase: "answering", round: 1, phaseKey: 2 },
  { phase: "reveal", round: 1, phaseKey: 3 },
  { phase: "scores", round: 1, phaseKey: 4 },
  { phase: "scores", round: 1, phaseKey: 5 }, // hold-resume: the phase starts again
];

describe("useQaRenderAck", () => {
  const original = process.env.EXPO_PUBLIC_QA;
  beforeEach(() => socket.emit.mockClear());
  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_QA;
    else process.env.EXPO_PUBLIC_QA = original;
  });

  it("with EXPO_PUBLIC_QA=1 acks each phase start once, with its phase, round and device time", () => {
    process.env.EXPO_PUBLIC_QA = "1";
    jest.spyOn(Date, "now").mockReturnValue(1_234);
    renderSteps(PHASES);
    expect(acks()).toEqual([
      { phase: "waiting-photo", round: 1, at: 1_234 },
      { phase: "answering", round: 1, at: 1_234 },
      { phase: "reveal", round: 1, at: 1_234 },
      { phase: "scores", round: 1, at: 1_234 },
      { phase: "scores", round: 1, at: 1_234 },
    ]);
    jest.restoreAllMocks();
  });

  it("adds handledAt to the ack of the phase whose handler marked it, only once (EXP-223)", () => {
    process.env.EXPO_PUBLIC_QA = "1";
    let mark!: MarkPhaseHandled;
    const Marker = (p: Props) => {
      mark = useQaRenderAck(socket as unknown as Socket, p.phase, p.round, p.phaseKey);
      return null;
    };
    const now = jest.spyOn(Date, "now");
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Marker phase={null} round={0} phaseKey={0} />); });
    now.mockReturnValue(100);
    mark("waiting-photo"); // the handler runs...
    now.mockReturnValue(130);
    act(() => r.update(<Marker phase="waiting-photo" round={1} phaseKey={1} />)); // ...then the screen commits
    mark("reveal"); // a mark for another phase is not this phase's
    act(() => r.update(<Marker phase="answering" round={1} phaseKey={2} />));
    act(() => r.update(<Marker phase="answering" round={1} phaseKey={3} />)); // resumed: no handler ran
    act(() => r.unmount());
    expect(acks()).toEqual([
      { phase: "waiting-photo", round: 1, at: 130, handledAt: 100 },
      { phase: "answering", round: 1, at: 130 },
      { phase: "answering", round: 1, at: 130 },
    ]);
    jest.restoreAllMocks();
  });

  it("does not ack again when only the round changes within a phase (your-turn)", () => {
    process.env.EXPO_PUBLIC_QA = "1";
    renderSteps([{ phase: "waiting-photo", round: 1, phaseKey: 1 }, { phase: "waiting-photo", round: 2, phaseKey: 1 }]);
    expect(acks()).toHaveLength(1);
  });

  it.each([undefined, "0", "true"])("never sends anything when EXPO_PUBLIC_QA is %p", (value) => {
    if (value === undefined) delete process.env.EXPO_PUBLIC_QA;
    else process.env.EXPO_PUBLIC_QA = value;
    renderSteps(PHASES);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("never sends anything from a release bundle, even with EXPO_PUBLIC_QA=1", () => {
    process.env.EXPO_PUBLIC_QA = "1";
    const dev = (global as { __DEV__?: boolean }).__DEV__;
    (global as { __DEV__?: boolean }).__DEV__ = false;
    try {
      renderSteps(PHASES);
    } finally {
      (global as { __DEV__?: boolean }).__DEV__ = dev;
    }
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
