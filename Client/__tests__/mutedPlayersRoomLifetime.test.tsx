import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { GameProvider, useGameContext } from "../src/providers/GameContext";
import { useMutedPlayers } from "../src/hooks/useMutedPlayers";

// EXP-422: a mute lasts for the player's stay in the room, as the app's game context runs it: a reconnect keeps it,
// on the same socket or on a new one for the same room (EXP-430: "Play again" while reconnecting), and leaving the
// room (Exit, kicked, an invite link to another room) clears it, so joining the same room again starts with nobody
// muted.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
// Every socket the app opens
const mockIoSockets: FakeSocket[] = [];
jest.mock("socket.io-client", () => ({
  io: () => {
    const { FakeSocket: Fake } = require("../testUtils/fakeSocket");
    const socket = new Fake();
    mockIoSockets.push(socket);
    return socket;
  },
}));

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });
beforeEach(() => {
  jest.useFakeTimers();
  mockIoSockets.length = 0;
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe("useMutedPlayers with the game context (EXP-422)", () => {
  let ctx!: ReturnType<typeof useGameContext>;
  let mutes!: ReturnType<typeof useMutedPlayers>;
  let r!: TestRenderer.ReactTestRenderer;
  const Probe = () => {
    ctx = useGameContext();
    mutes = useMutedPlayers(ctx.gameCode);
    return null;
  };
  /** In room `code` on a fresh socket, with bob muted */
  const joinAndMuteBob = (code: string) => {
    act(() => { r = TestRenderer.create(<GameProvider><Probe /></GameProvider>); });
    act(() => ctx.startSocket());
    act(() => ctx.setGameCode(code));
    act(() => mutes.toggle("bob"));
    expect(mutes.muted.has("bob")).toBe(true);
  };
  afterEach(() => act(() => r.unmount()));

  it("survives a reconnect, and is cleared by leaving the room, even when the same room is joined again", () => {
    joinAndMuteBob("ROOM20");

    // socket.io reconnects the same socket object; the rejoin's room-of-game sets the same room
    const roomSocket = mockIoSockets[0];
    act(() => {
      roomSocket.connected = false;
      roomSocket.fire("disconnect", "transport close");
      roomSocket.connected = true;
      roomSocket.fire("connect");
    });
    act(() => ctx.setGameCode("ROOM20"));
    expect(mutes.muted.has("bob")).toBe(true);

    // Exit: the room and its socket are dropped
    act(() => ctx.leaveRoom());
    expect(mutes.muted.size).toBe(0);

    // Joining the same room again is a new stay in it: nobody muted
    act(() => ctx.startSocket());
    act(() => ctx.setGameCode("ROOM20"));
    expect(mockIoSockets).toHaveLength(2);
    expect(mutes.muted.size).toBe(0);
  });

  it("survives the lobby replacing a disconnected socket for the same room (Play again while reconnecting, EXP-430)", () => {
    joinAndMuteBob("ROOM21");
    mockIoSockets[0].connected = false;

    act(() => ctx.startSocket());
    act(() => ctx.setGameCode("ROOM21")); // the new socket's room-of-game
    expect(mockIoSockets).toHaveLength(2);
    expect(ctx.socket).toBe(mockIoSockets[1]);
    expect(mutes.muted.has("bob")).toBe(true);
  });

  it("is cleared when the socket is ended (kicked, room gone) and when the app joins another room", () => {
    joinAndMuteBob("ROOM22");
    act(() => ctx.endSocket());
    expect(mutes.muted.size).toBe(0);
    act(() => r.unmount());

    joinAndMuteBob("ROOM23");
    act(() => ctx.setGameCode("ROOM24")); // an invite link's Join
    expect(mutes.muted.size).toBe(0);
  });
});
