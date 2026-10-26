import { attachHandlers } from "../app/utils/socketHandlers";

// EXP-248: a screen removes only the listeners it attached; others on the shared socket stay

type Handler = (...args: any[]) => void;
const makeSocket = () => {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    on(ev: string, fn: Handler) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
      return this;
    },
    off(ev: string, fn?: Handler) {
      if (fn) handlers.get(ev)?.delete(fn);
      else handlers.delete(ev);
      return this;
    },
  };
};

describe("attachHandlers", () => {
  it("attaches every handler of the table and detach removes only those", () => {
    const socket = makeSocket();
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
    const socket = makeSocket();
    const detach = attachHandlers(socket, { "round-start": jest.fn() });
    const offSpy = jest.spyOn(socket, "off");
    detach();
    detach();
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});
