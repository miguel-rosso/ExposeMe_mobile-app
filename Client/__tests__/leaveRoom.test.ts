import { LEAVE_ACK_TIMEOUT_MS, leaveAndClose, LeavingSocket } from "../app/utils/leaveRoom";

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
