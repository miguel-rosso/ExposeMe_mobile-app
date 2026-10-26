import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { useGameConnection } from "../app/hooks/useGameConnection";

// EXP-180: in game, a connection the server refuses (e.g. "Too many connections") is final for socket.io, so the
// game screen leaves with the server's reason (translated on the home screen) instead of "Reconnecting…" forever.

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

  it("removes only its own connect_error listener on unmount", () => {
    const t = setup();
    t.socket.on("connect_error", jest.fn());
    expect(t.socket.listenerCount("connect_error")).toBe(2);
    act(() => t.r.unmount());
    expect(t.socket.listenerCount("connect_error")).toBe(1);
  });
});
