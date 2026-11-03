import {
  LEAVE_ACK_TIMEOUT_MS, leaveAndClose, leaveFromAnywhere, LeavingSocket, OFFLINE_LEAVE_TIMEOUT_MS, OfflineLeavingSocket,
} from "../app/utils/leaveRoom";

// EXP-254: closing the socket in the same tick as leave-room can lose the leave (the server drops an event it
// dispatches after the disconnect). The leave waits for the server's ack, and closes anyway after a short cap so
// leaving never hangs.

const makeSocket = () => {
  let ack: (() => void) | undefined;
  const socket = {
    emit: jest.fn((_ev: string, cb?: () => void) => { ack = cb; }),
    disconnect: jest.fn(),
  };
  return { socket: socket as typeof socket & LeavingSocket, ack: () => ack!() };
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("leaveAndClose (EXP-254)", () => {
  it("sends leave-room with an ack and keeps the socket open until the server acks it", () => {
    const { socket, ack } = makeSocket();
    leaveAndClose(socket);
    expect(socket.emit).toHaveBeenCalledWith("leave-room", expect.any(Function));
    expect(socket.disconnect).not.toHaveBeenCalled();

    ack();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS); // the cap does not close it a second time
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("without an ack, closes the socket once the cap runs out (never hangs), and a late ack changes nothing", () => {
    const { socket, ack } = makeSocket();
    leaveAndClose(socket);
    jest.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS - 1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);

    ack();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});

// EXP-377: Exit while reconnecting. The reconnection is a new server socket bound to no room, whose bare leave-room the
// server ignores: the others would wait for a lost connection (a paused game: up to 5 min). The leave waits for the
// reconnection (bounded) and then names the seat it gives up, with its token (EXP-387): never a rejoin first, which
// would resume a paused game for the others one round trip before the leave ends it.
describe("leaveFromAnywhere (EXP-377)", () => {
  const SEAT = { gameCode: "ABC123", username: "bob", rejoinToken: "tok-1" };
  const makeOfflineSocket = () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let ack: (() => void) | undefined;
    const socket = {
      connected: false,
      emit: jest.fn((ev: string, ...args: unknown[]) => { if (ev === "leave-room") ack = args[args.length - 1] as () => void; }),
      disconnect: jest.fn(),
      once: jest.fn((ev: string, fn: (...args: unknown[]) => void) => { listeners.set(ev, fn); }),
      off: jest.fn((ev: string, fn: (...args: unknown[]) => void) => { if (listeners.get(ev) === fn) listeners.delete(ev); }),
    };
    const fire = (ev: string, ...args: unknown[]) => {
      const fn = listeners.get(ev);
      listeners.delete(ev);
      fn?.(...args);
    };
    return { socket: socket as unknown as typeof socket & OfflineLeavingSocket, fire, ack: () => ack!() };
  };
  const events = (socket: { emit: jest.Mock }) => socket.emit.mock.calls.map(([ev]) => ev);

  it("connected: leaves at once, as leaveAndClose", () => {
    const { socket, ack } = makeOfflineSocket();
    socket.connected = true;
    leaveFromAnywhere(socket, SEAT);
    expect(events(socket)).toEqual(["leave-room"]);
    ack();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("offline: sends nothing meanwhile; once back, leaves naming the seat (no rejoin), closing on the ack", () => {
    const { socket, fire, ack } = makeOfflineSocket();
    leaveFromAnywhere(socket, SEAT);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();

    fire("connect");
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith("leave-room", { gameCode: "ABC123", username: "bob", rejoinToken: "tok-1" }, expect.any(Function));
    expect(socket.disconnect).not.toHaveBeenCalled();
    ack();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(OFFLINE_LEAVE_TIMEOUT_MS); // the give-up timer is gone
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  // Once the leave is sent only it closes the socket: a bare close could beat the leave to the server
  it("back just before the bound: the give-up timer can't close it, only the leave does (its ack or its cap)", () => {
    const { socket, fire } = makeOfflineSocket();
    leaveFromAnywhere(socket, SEAT);
    jest.advanceTimersByTime(OFFLINE_LEAVE_TIMEOUT_MS - 1);
    fire("connect");
    expect(events(socket)).toEqual(["leave-room"]);

    jest.advanceTimersByTime(1); // past the bound: nothing
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS - 1); // no ack (slow server): the leave's own cap closes it
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("offline for good: gives up and closes after the bound, drops its connect listener and never rejoins", () => {
    const { socket, fire } = makeOfflineSocket();
    leaveFromAnywhere(socket, SEAT);
    jest.advanceTimersByTime(OFFLINE_LEAVE_TIMEOUT_MS - 1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledWith("connect", socket.once.mock.calls[0][1]);
    fire("connect"); // a connect after the give-up (the listener is gone: the token is not held any more)
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("offline with no seat to name (no token for this room): closes as before", () => {
    const { socket } = makeOfflineSocket();
    leaveFromAnywhere(socket, null);
    expect(socket.emit).toHaveBeenCalledWith("leave-room", expect.any(Function));
    jest.advanceTimersByTime(LEAVE_ACK_TIMEOUT_MS);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });
});
