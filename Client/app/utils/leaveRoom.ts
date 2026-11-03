import type { Socket } from "socket.io-client";

/** How long a leave waits for the server's ack before closing the socket anyway (offline, no answer). */
export const LEAVE_ACK_TIMEOUT_MS = 1000;
/** How long a leave from an offline socket waits for it to come back before giving up (EXP-377). */
export const OFFLINE_LEAVE_TIMEOUT_MS = 10_000;

/** The part of a socket.io socket that a leave needs. */
export type LeavingSocket = Pick<Socket, "emit" | "disconnect">;
/** The part of a socket.io socket that a leave from offline needs: it waits for the reconnection. */
export type OfflineLeavingSocket = LeavingSocket & Pick<Socket, "connected" | "once" | "off">;

/**
 * The room seat to give up: where the socket was bound, and the rejoin token that proves it is ours. A leave-room from
 * a socket bound to no room names it (see Server/GAME_FLOW.md «Leaving»).
 */
export interface LeavingSeat {
  gameCode: string;
  username: string;
  rejoinToken: string;
}

/**
 * Send leave-room and close the socket once the server acks it, or after `timeoutMs` without an answer, whichever
 * comes first. Closing in the same tick as the emit can lose the leave: the server drops an event it dispatches after
 * the disconnect, and the player is then treated as a lost connection instead of someone who left. A bound socket
 * names no `seat` (the server leaves its binding); one bound to no room names the seat it gives up.
 */
export function leaveAndClose(socket: LeavingSocket, seat: LeavingSeat | null = null, timeoutMs = LEAVE_ACK_TIMEOUT_MS): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket.disconnect();
  };
  const timer = setTimeout(close, timeoutMs);
  if (seat) socket.emit("leave-room", seat, close);
  else socket.emit("leave-room", close);
}

/**
 * Leave, also from a socket that is offline (reconnecting). Its reconnection is a new server socket bound to no room,
 * whose bare leave-room the server would ignore, so the others would keep waiting for a lost connection (a paused
 * game: up to 5 min). So it waits up to `timeoutMs` for the reconnection, then leaves naming the seat with its token
 * (EXP-387): the server removes that seat without binding the socket to it first, so a paused game never resumes for
 * the others one round trip before the leave ends it. Once the leave is sent only it closes the socket (its ack or its
 * cap). If the socket doesn't come back in time it is closed and the server goes by the lost connection. The token is
 * dropped as soon as it is used or the wait is over.
 */
export function leaveFromAnywhere(
  socket: OfflineLeavingSocket, seat: LeavingSeat | null, timeoutMs = OFFLINE_LEAVE_TIMEOUT_MS,
): void {
  if (socket.connected || !seat) {
    leaveAndClose(socket);
    return;
  }
  let pendingSeat: LeavingSeat | null = seat;
  const leaveSeat = () => {
    clearTimeout(giveUp);
    const named = pendingSeat;
    pendingSeat = null;
    leaveAndClose(socket, named);
  };
  const giveUp = setTimeout(() => {
    socket.off("connect", leaveSeat);
    pendingSeat = null;
    socket.disconnect();
  }, timeoutMs);
  socket.once("connect", leaveSeat);
}
