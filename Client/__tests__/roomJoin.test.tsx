import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { FakeSocket } from "../testUtils/fakeSocket";
import { emitJoin, isConnectionRefused } from "../src/utils/roomJoin";
import { useGameConnection } from "../src/hooks/useGameConnection";

// EXP-234: the lobby and the game share how they join a room (join-create-game) and tell a refused connection from a
// network error. The screens' own behaviour is pinned in waitingRoomRejoin, waitingRoomServerRefusal, gameReconnect
// and gameConnectionRefusal; this pins the shared helpers and the game's token-less rejoin.

beforeAll(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterAll(() => { jest.restoreAllMocks(); });

const flush = () => act(async () => { await Promise.resolve(); });

describe("emitJoin", () => {
  it("sends the rejoin token when there is one", () => {
    const socket = new FakeSocket();
    emitJoin(socket, { gameCode: "ABC234", username: "bob", rejoinToken: "tok-1" });
    expect(socket.emitted).toEqual([["join-create-game", { gameCode: "ABC234", username: "bob", rejoinToken: "tok-1" }]]);
  });

  it.each([["null", null], ["undefined", undefined], ["empty", ""]])(
    "leaves the token key out when it is %s",
    (_name, rejoinToken) => {
      const socket = new FakeSocket();
      emitJoin(socket, { gameCode: "ABC234", username: "bob", rejoinToken });
      expect(socket.emitted).toEqual([["join-create-game", { gameCode: "ABC234", username: "bob" }]]);
    }
  );

  it("asks for a new room with a null code (home's Create game)", () => {
    const socket = new FakeSocket();
    emitJoin(socket, { gameCode: null, username: "bob" });
    expect(socket.emitted).toEqual([["join-create-game", { gameCode: null, username: "bob" }]]);
  });
});

describe("isConnectionRefused", () => {
  it("is a refusal once socket.io stopped trying, a network error while it still retries", () => {
    const socket = new FakeSocket();
    expect(isConnectionRefused(socket)).toBe(false);
    socket.active = false;
    expect(isConnectionRefused(socket)).toBe(true);
  });
});

describe("useGameConnection: rejoin without a stored token (characterization)", () => {
  it("rejoins with the name alone", async () => {
    const socket = new FakeSocket();
    const Probe = () => {
      useGameConnection({
        socket: socket as any, gameCode: "ABC234", username: "bob",
        getRejoinToken: async () => null, saveRejoinToken: jest.fn(), onLeave: jest.fn(),
      });
      return null;
    };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<Probe />); });

    await act(async () => { socket.fire("connect"); });
    await flush();

    expect(socket.emittedPayloads("join-create-game")).toEqual([{ gameCode: "ABC234", username: "bob" }]);
    act(() => r.unmount());
  });
});
