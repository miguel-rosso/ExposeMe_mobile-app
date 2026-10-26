import type { Socket } from "socket.io-client";

/** How long a leave waits for the server's ack before closing the socket anyway (offline, no answer). */
export const LEAVE_ACK_TIMEOUT_MS = 1000;

/** The part of a socket.io socket that a leave needs. */
export type LeavingSocket = Pick<Socket, "emit" | "disconnect">;

/**
 * Send leave-room and close the socket once the server acks it, or after `timeoutMs` without an answer, whichever
 * comes first. Closing in the same tick as the emit can lose the leave: the server drops an event it dispatches after
 * the disconnect, and the player is then treated as a lost connection instead of someone who left.
 */
export function leaveAndClose(socket: LeavingSocket, timeoutMs = LEAVE_ACK_TIMEOUT_MS): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket.disconnect();
  };
  const timer = setTimeout(close, timeoutMs);
  socket.emit("leave-room", close);
}
