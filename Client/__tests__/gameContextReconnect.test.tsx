import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { AppState } from "react-native";

// EXP-006 / DEC-009: the game socket must keep reconnecting for as long as the server waits for the player
// (a 2-player game pauses for 5 min), and returning to the foreground (iOS suspends sockets) reconnects at once.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockSocket = { connected: true, connect: jest.fn(), disconnect: jest.fn(), removeAllListeners: jest.fn() };
const mockIo = jest.fn((..._args: unknown[]) => mockSocket);
jest.mock("socket.io-client", () => ({ io: (...args: unknown[]) => mockIo(...args) }));

import { GameProvider, useGameContext } from "../app/providers/GameContext";

describe("GameContext socket", () => {
  it("never gives up reconnecting, and reconnects when the app returns to the foreground", () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    let appStateHandler: ((s: string) => void) | undefined;
    const spy = jest.spyOn(AppState, "addEventListener").mockImplementation(((_: string, h: (s: string) => void) => {
      appStateHandler = h;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);

    let ctx!: ReturnType<typeof useGameContext>;
    const Probe = () => { ctx = useGameContext(); return null; };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    act(() => ctx.startSocket());
    expect(mockIo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reconnection: true, reconnectionAttempts: Infinity }));

    act(() => appStateHandler!("active"));
    expect(mockSocket.connect).not.toHaveBeenCalled(); // still connected

    mockSocket.connected = false;
    act(() => appStateHandler!("background"));
    expect(mockSocket.connect).not.toHaveBeenCalled();
    act(() => appStateHandler!("active"));
    expect(mockSocket.connect).toHaveBeenCalledTimes(1);

    act(() => r.unmount());
    spy.mockRestore();
    jest.restoreAllMocks();
  });
});
