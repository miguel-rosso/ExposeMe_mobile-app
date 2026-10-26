import { attachHandlers } from "../app/utils/socketHandlers";
import { FakeSocket } from "../testUtils/fakeSocket";

// EXP-248: a screen removes only the listeners it attached; others on the shared socket stay

describe("attachHandlers", () => {
  it("attaches every handler of the table and detach removes only those", () => {
    const socket = new FakeSocket();
    const foreign = jest.fn();
    socket.on("game-state", foreign);
    const onState = jest.fn();
    const onLeft = jest.fn();
    const detach = attachHandlers(socket, { "game-state": onState, "player-left": onLeft });
    expect([...socket.handlers.get("game-state")!]).toEqual([foreign, onState]);
    expect([...socket.handlers.get("player-left")!]).toEqual([onLeft]);

    detach();
    expect([...socket.handlers.get("game-state")!]).toEqual([foreign]);
    expect(socket.handlers.get("player-left")?.size ?? 0).toBe(0);
  });

  it("detaching twice is harmless (game over, then unmount)", () => {
    const socket = new FakeSocket();
    const detach = attachHandlers(socket, { "round-start": jest.fn() });
    const offSpy = jest.spyOn(socket, "off");
    detach();
    detach();
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});
