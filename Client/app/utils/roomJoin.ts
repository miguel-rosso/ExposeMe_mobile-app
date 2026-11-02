// ── Joining a room ──
// The lobby and the game screen both join (or rejoin) a room on the shared socket and both watch for a connection the
// server refuses: one way to do each, see Server/GAME_FLOW.md.
import type { JoinCreateGameData } from "../models/interfaces";

interface JoinRequest {
  /** The room to join, or null to ask the server for a new one (home's Create game) */
  gameCode: string | null;
  username: string;
  /** The stored rejoin token for this room and name, if any: without it the server refuses a name already taken */
  rejoinToken?: string | null;
}

/** Joins (or rejoins) a room: join-create-game, carrying the rejoin token only when there is one. */
export const emitJoin = (
  socket: { emit(event: "join-create-game", data: JoinCreateGameData): unknown },
  { gameCode, username, rejoinToken }: JoinRequest
): void => {
  socket.emit("join-create-game", { gameCode, username, ...(rejoinToken ? { rejoinToken } : {}) });
};

/**
 * Whether a connect_error is the server refusing the connection itself (e.g. "Too many connections"): socket.io won't
 * retry that, so anything waiting for the connection would wait forever. A network error leaves the socket active and
 * it keeps retrying on its own.
 */
export const isConnectionRefused = (socket: { active: boolean }): boolean => !socket.active;
