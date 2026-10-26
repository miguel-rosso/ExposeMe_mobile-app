import { Socket } from "socket.io-client";

type EmittingSocket = Pick<Socket, "connected" | "emit">;

/**
 * Emits only while connected, and says whether it did. socket.io buffers what is emitted offline and flushes it as
 * soon as it reconnects, on the new server socket and before the game rejoin: the server drops it there (that socket
 * is in no room yet), but it spends that socket's rate limits (e.g. submit-answer's) right before the rejoin's own
 * re-sends. What still matters after a reconnect is re-sent from the rejoin's `game-state` snapshot instead.
 *
 * Not `socket.volatile`: that also drops an emit made while connected whenever the transport is busy writing, which
 * could lose an answer.
 */
export const emitWhileConnected = (
  socket: EmittingSocket | null | undefined, event: string, ...args: unknown[]
): boolean => {
  if (!socket?.connected) return false;
  socket.emit(event, ...args);
  return true;
};
