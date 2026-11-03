import React, { memo, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";

// EXP-403: GameProvider hands out a memoized value whose functions keep their identity for the provider's lifetime.
// A render of the provider that changes none of its state gives consumers the same value (no re-render for them), and
// a consumer's effect that lists a context function among its deps (e.g. home's focus effect on takeHomeNotice) does
// not run again on every state change. A function kept from an earlier render still works on the current state.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const makeSocket = () => ({
  connected: true, connect: jest.fn(), disconnect: jest.fn(), removeAllListeners: jest.fn(), emit: jest.fn(),
  on: jest.fn(), once: jest.fn(), off: jest.fn(),
});
type MockSocket = ReturnType<typeof makeSocket>;
const mockSockets: MockSocket[] = [];
jest.mock("socket.io-client", () => ({
  io: () => { const s = makeSocket(); mockSockets.push(s); return s; },
}));

import { GameProvider, useGameContext } from "../app/providers/GameContext";
import type { GameContextProps } from "../app/models/interfaces";

type Ctx = GameContextProps;

let ctx!: Ctx;
let consumerRenders = 0;

/** A consumer that only re-renders when the context value changes (memo: no props of its own). */
const MemoConsumer = memo(() => {
  ctx = useGameContext();
  consumerRenders += 1;
  return null;
});

/** Stands for the provider's parent (the root layout), with state of its own unrelated to the game context. */
let rerenderParent!: () => void;
const Parent = () => {
  const [, setTick] = useState(0);
  rerenderParent = () => setTick((t) => t + 1);
  return <GameProvider><MemoConsumer /></GameProvider>;
};

const mount = () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<Parent />); });
  return r;
};

/** The context's functions, by name. */
const functionsOf = (value: Ctx): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "function"));

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(async () => {
  await AsyncStorage.clear();
  mockSockets.length = 0;
  consumerRenders = 0;
});
afterEach(() => { jest.useRealTimers(); });

describe("GameContext value memoization (EXP-403)", () => {
  it("a render of the provider that changes none of its state does not re-render its consumers", async () => {
    const r = mount();
    await act(async () => { await Promise.resolve(); }); // stored name read at start
    const before = ctx;
    const renders = consumerRenders;

    act(() => rerenderParent());
    act(() => rerenderParent());

    expect(consumerRenders).toBe(renders);
    expect(ctx).toBe(before);
    act(() => r.unmount());
  });

  it("a state change re-renders consumers with the new state, and every function keeps its identity", async () => {
    const r = mount();
    await act(async () => { await Promise.resolve(); });
    const initialFunctions = functionsOf(ctx);
    expect(Object.keys(initialFunctions).length).toBeGreaterThan(20);

    act(() => ctx.setJoinCodeDraft("K7MQ"));
    expect(ctx.joinCodeDraft).toBe("K7MQ");
    act(() => ctx.saveUsername("bob"));
    expect(ctx.username).toBe("bob");
    act(() => ctx.setGameCode("ABC123"));
    expect(ctx.gameCode).toBe("ABC123");
    act(() => ctx.setRoundsOfGame(7));
    expect(ctx.roundsOfGame).toBe(7);
    act(() => ctx.setPlayersProvider([{ username: "bob" } as Ctx["playersProvider"][number]]));
    expect(ctx.playersProvider).toHaveLength(1);
    act(() => ctx.setPlantedPhotoUri("file:///planted.jpg"));
    expect(ctx.plantedPhotoUri).toBe("file:///planted.jpg");
    act(() => ctx.startSocket());
    expect(ctx.socket).toBe(mockSockets[0]);

    const current = functionsOf(ctx);
    const replaced = Object.keys(initialFunctions).filter((name) => current[name] !== initialFunctions[name]);
    expect(replaced).toEqual([]);
    act(() => r.unmount());
  });

  // The seat leaveRoom hands an offline socket is the current room's: kept from the first render (gameCode null
  // then), it must still find it, or Exit while reconnecting would leave a lost connection instead (EXP-377)
  it("leaveRoom kept from the first render still leaves the current room's seat", async () => {
    jest.useFakeTimers();
    const r = mount();
    const leaveRoomFromFirstRender = ctx.leaveRoom;

    act(() => ctx.setGameCode("ABC123"));
    act(() => ctx.saveRejoinToken("ABC123", "bob", "tok-1"));
    act(() => ctx.startSocket());
    const leaving = mockSockets[0];
    leaving.connected = false; // reconnecting

    act(() => leaveRoomFromFirstRender());
    expect(ctx.socket).toBeNull();
    expect(leaving.emit).not.toHaveBeenCalled(); // waits for the reconnection, then leaves naming the seat (EXP-387)
    const onConnect = leaving.once.mock.calls.find(([ev]: unknown[]) => ev === "connect")![1] as () => void;
    onConnect();
    expect(leaving.emit).toHaveBeenCalledWith(
      "leave-room", { gameCode: "ABC123", username: "bob", rejoinToken: "tok-1" }, expect.any(Function),
    );
    act(() => r.unmount());
  });

  it("a room code set and left in the same tick leaves that room's seat", async () => {
    jest.useFakeTimers();
    const r = mount();
    act(() => ctx.saveRejoinToken("ABC123", "bob", "tok-1"));
    act(() => ctx.startSocket());
    const leaving = mockSockets[0];
    leaving.connected = false;

    act(() => {
      ctx.setGameCode("ABC123");
      ctx.leaveRoom();
    });
    expect(leaving.once).toHaveBeenCalledWith("connect", expect.any(Function));
    act(() => r.unmount());
  });
});
