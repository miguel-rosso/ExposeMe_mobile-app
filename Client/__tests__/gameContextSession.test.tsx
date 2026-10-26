import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";

// EXP-063: the session kept by GameContext. The rejoin token survives an app restart (AsyncStorage) and is only
// handed out for the same room and username; the socket is reused while connected, replaced (old listeners
// dropped) once it is dead, and endSocket closes it for good.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const makeSocket = () => ({ connected: true, connect: jest.fn(), disconnect: jest.fn(), removeAllListeners: jest.fn(), emit: jest.fn() });
type MockSocket = ReturnType<typeof makeSocket>;
const mockSockets: MockSocket[] = [];
const mockIo = jest.fn(() => { const s = makeSocket(); mockSockets.push(s); return s; });
jest.mock("socket.io-client", () => ({ io: () => mockIo() }));

import { GameProvider, useGameContext } from "../app/providers/GameContext";

let ctx!: ReturnType<typeof useGameContext>;
const Probe = () => { ctx = useGameContext(); return null; };
const mount = () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
  return r;
};

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(async () => {
  await AsyncStorage.clear();
  mockIo.mockClear();
  mockSockets.length = 0;
});

describe("GameContext rejoin token (EXP-063)", () => {
  it("is stored, and read back after an app restart (new provider) for the same room and username only", async () => {
    let r = mount();
    act(() => ctx.saveRejoinToken("ABC123", "bob", "tok-1"));
    await act(async () => { await Promise.resolve(); });
    expect(JSON.parse((await AsyncStorage.getItem("rejoinToken"))!)).toEqual({ gameCode: "ABC123", username: "bob", token: "tok-1" });
    act(() => r.unmount());

    r = mount(); // app reopened: nothing in memory
    await expect(ctx.getRejoinToken("ABC123", "bob")).resolves.toBe("tok-1");
    await expect(ctx.getRejoinToken("ABC123", "alice")).resolves.toBeNull();
    await expect(ctx.getRejoinToken("999999", "bob")).resolves.toBeNull();
    act(() => r.unmount());
  });

  it("a new room replaces the previous token", async () => {
    const r = mount();
    act(() => ctx.saveRejoinToken("ABC123", "bob", "tok-1"));
    act(() => ctx.saveRejoinToken("654321", "bob", "tok-2"));
    await expect(ctx.getRejoinToken("ABC123", "bob")).resolves.toBeNull();
    await expect(ctx.getRejoinToken("654321", "bob")).resolves.toBe("tok-2");
    act(() => r.unmount());
  });

  it("clearRejoinToken forgets it in memory and in storage", async () => {
    let r = mount();
    act(() => ctx.saveRejoinToken("ABC123", "bob", "tok-1"));
    act(() => ctx.clearRejoinToken());
    await expect(ctx.getRejoinToken("ABC123", "bob")).resolves.toBeNull();
    await act(async () => { await Promise.resolve(); });
    act(() => r.unmount());
    r = mount();
    await expect(ctx.getRejoinToken("ABC123", "bob")).resolves.toBeNull();
    act(() => r.unmount());
  });

  it("a corrupt stored entry is treated as no token", async () => {
    await AsyncStorage.setItem("rejoinToken", "{not json");
    const r = mount();
    await expect(ctx.getRejoinToken("ABC123", "bob")).resolves.toBeNull();
    act(() => r.unmount());
  });
});

describe("GameContext socket lifecycle (EXP-063)", () => {
  it("reuses a connected socket, replaces a dead one (dropping its listeners), and endSocket closes it", () => {
    const r = mount();
    expect(ctx.socket).toBeNull();
    act(() => ctx.startSocket());
    const first = mockSockets[0];
    expect(ctx.socket).toBe(first);

    act(() => ctx.startSocket()); // still connected: same socket
    expect(mockIo).toHaveBeenCalledTimes(1);

    first.connected = false;
    act(() => ctx.startSocket());
    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalled();
    expect(mockIo).toHaveBeenCalledTimes(2);
    const second = mockSockets[1];
    expect(ctx.socket).toBe(second);

    act(() => ctx.endSocket());
    expect(second.removeAllListeners).toHaveBeenCalled();
    expect(second.disconnect).toHaveBeenCalled();
    expect(ctx.socket).toBeNull();

    act(() => ctx.startSocket()); // next game: a brand new socket
    expect(mockIo).toHaveBeenCalledTimes(3);
    act(() => r.unmount());
  });
});
