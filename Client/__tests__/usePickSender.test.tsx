import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PICK_SEND_INTERVAL, PickRound, usePickSender } from "../app/hooks/usePickSender";

// EXP-233: throttled sending of my pick (submit-answer), extracted from GameScreen

const makeSocket = () => ({ connected: true, emit: jest.fn() });
type PickSender = ReturnType<typeof usePickSender>;

// Renders the hook in a probe component; the round ref plays GameScreen's roundRef (latest state)
const mount = (socket: ReturnType<typeof makeSocket>) => {
  const roundRef: { current: PickRound } = { current: { mySelection: "", round: 1, phase: "answering" } };
  const senderRef: { current: PickSender | null } = { current: null };
  const Probe = () => { senderRef.current = usePickSender(socket as any, roundRef); return null; };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Probe />); });
  const pick = (guess: string) => {
    roundRef.current = { ...roundRef.current, mySelection: guess };
    senderRef.current!.pickChanged();
  };
  const rerender = () => act(() => renderer.update(<Probe />));
  return { roundRef, sender: () => senderRef.current!, pick, renderer, rerender };
};
const sent = (socket: ReturnType<typeof makeSocket>) =>
  socket.emit.mock.calls.filter(([ev]) => ev === "submit-answer").map(([, payload]) => payload.guess);

describe("usePickSender", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it("sends the first pick at once and coalesces rapid ones into one trailing send of the latest", () => {
    const socket = makeSocket();
    const { pick } = mount(socket);
    pick("carol");
    pick("bob");
    pick("alice");
    expect(sent(socket)).toEqual(["carol"]);
    act(() => { jest.advanceTimersByTime(PICK_SEND_INTERVAL - 1); });
    expect(sent(socket)).toEqual(["carol"]);
    act(() => { jest.advanceTimersByTime(1); });
    expect(sent(socket)).toEqual(["carol", "alice"]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(sent(socket)).toEqual(["carol", "alice"]);
  });

  it("sends a pick at once when its slot is free, and counts the slot from the last send", () => {
    const socket = makeSocket();
    const { pick } = mount(socket);
    pick("carol");
    act(() => { jest.advanceTimersByTime(PICK_SEND_INTERVAL); });
    pick("alice");
    expect(sent(socket)).toEqual(["carol", "alice"]);
    act(() => { jest.advanceTimersByTime(PICK_SEND_INTERVAL / 2); });
    pick("bob");
    expect(sent(socket)).toEqual(["carol", "alice"]);
    act(() => { jest.advanceTimersByTime(PICK_SEND_INTERVAL / 2); });
    expect(sent(socket)).toEqual(["carol", "alice", "bob"]);
  });

  it("drops the trailing send once answering is over or another round started", () => {
    const socket = makeSocket();
    const { pick, roundRef } = mount(socket);
    pick("carol");
    pick("alice");
    roundRef.current = { ...roundRef.current, phase: "reveal" };
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(sent(socket)).toEqual(["carol"]);

    // The dropped trailing send leaves no pending state behind: the next round's first pick goes at once
    roundRef.current = { mySelection: "", round: 2, phase: "answering" };
    pick("bob");
    expect(sent(socket)).toEqual(["carol", "bob"]);
    pick("alice");
    roundRef.current = { ...roundRef.current, round: 3 };
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(sent(socket)).toEqual(["carol", "bob"]);
  });

  it("flushPending sends a waiting pick at once, once; with nothing waiting it sends nothing", () => {
    const socket = makeSocket();
    const { pick, sender } = mount(socket);
    sender().flushPending();
    expect(sent(socket)).toEqual([]);
    pick("carol");
    pick("alice");
    sender().flushPending();
    expect(sent(socket)).toEqual(["carol", "alice"]);
    act(() => { jest.advanceTimersByTime(1_000); });
    sender().flushPending();
    expect(sent(socket)).toEqual(["carol", "alice"]);
  });

  it("resendAfterRejoin sends the current pick (taking a waiting one), and nothing without a pick", () => {
    const socket = makeSocket();
    const { pick, sender } = mount(socket);
    sender().resendAfterRejoin();
    expect(sent(socket)).toEqual([]);
    pick("carol");
    pick("alice");
    sender().resendAfterRejoin();
    expect(sent(socket)).toEqual(["carol", "alice"]);
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(sent(socket)).toEqual(["carol", "alice"]);
  });

  it("emits nothing while offline, and the offline attempt still takes the throttle slot", () => {
    const socket = makeSocket();
    const { pick } = mount(socket);
    socket.connected = false;
    pick("carol");
    socket.connected = true;
    pick("alice");
    expect(sent(socket)).toEqual([]);
    act(() => { jest.advanceTimersByTime(PICK_SEND_INTERVAL); });
    expect(sent(socket)).toEqual(["alice"]);
  });

  it("drops a pick still waiting when it unmounts", () => {
    const socket = makeSocket();
    const { pick, renderer } = mount(socket);
    pick("carol");
    pick("alice");
    act(() => renderer.unmount());
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(sent(socket)).toEqual(["carol"]);
  });

  it("keeps the same actions across re-renders (socket listeners attached once hold them)", () => {
    const socket = makeSocket();
    const { sender, rerender } = mount(socket);
    const first = sender();
    rerender();
    expect(sender()).toBe(first);
  });
});
