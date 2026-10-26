import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useGameConnection } from "../app/hooks/useGameConnection";

// EXP-180: in game, a connection the server refuses (e.g. "Too many connections") is final for socket.io, so the
// game screen leaves with the server's reason (translated on the home screen) instead of "Reconnecting…" forever.

type Handler = (...args: any[]) => void;
class FakeSocket {
  connected = true;
  /** socket.io's `active`: false once the server refused the connection and no reconnection will follow */
  active = true;
  handlers = new Map<string, Set<Handler>>();
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn: Handler) {
    this.handlers.get(ev)?.delete(fn);
    return this;
  }
  emit() {
    return this;
  }
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
  listeners(ev: string) {
    return this.handlers.get(ev)?.size ?? 0;
  }
}

const setup = () => {
  const socket = new FakeSocket();
  const onLeave = jest.fn();
  const Probe = () => {
    useGameConnection({
      socket: socket as any, gameCode: "ABC234", username: "bob",
      getRejoinToken: async () => "tok-123", saveRejoinToken: jest.fn(), onLeave,
    });
    return null;
  };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<Probe />); });
  return { socket, onLeave, r };
};

describe("useGameConnection: connection refused by the server (EXP-180)", () => {
  it("leaves the game with the server's reason when socket.io won't retry", () => {
    const t = setup();
    t.socket.active = false;
    act(() => t.socket.fire("connect_error", new Error("Too many connections")));
    expect(t.onLeave).toHaveBeenCalledWith("Too many connections");
    act(() => t.r.unmount());
  });

  it("keeps reconnecting on a network error", () => {
    const t = setup();
    act(() => t.socket.fire("connect_error", new Error("xhr poll error")));
    expect(t.onLeave).not.toHaveBeenCalled();
    act(() => t.r.unmount());
  });

  it("removes its connect_error listener on unmount", () => {
    const t = setup();
    expect(t.socket.listeners("connect_error")).toBe(1);
    act(() => t.r.unmount());
    expect(t.socket.listeners("connect_error")).toBe(0);
  });
});
