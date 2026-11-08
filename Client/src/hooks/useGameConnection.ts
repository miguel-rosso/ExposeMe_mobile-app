import { useCallback, useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { RoomOfGameResponse } from "../models/interfaces";
import { attachHandlers } from "../utils/socketHandlers";
import { shouldReplantAfterRejoin } from "../utils/plantedPhoto";
import { emitJoin, isConnectionRefused } from "../utils/roomJoin";

/** The photo picked in the lobby to plant in this game (GameContext). */
interface PlantedPhotoState {
  uri: string | null;
  sent: boolean;
  plant: () => Promise<boolean>;
}

interface GameConnectionOptions {
  socket: Socket | null;
  gameCode: string | null;
  username: string | null;
  getRejoinToken: (gameCode: string, username: string) => Promise<string | null>;
  saveRejoinToken: (gameCode: string, username: string, token: string) => void;
  /** We can't get back into the game (kicked, room gone, rejoin or connection refused): leave the game screen */
  onLeave: (message?: string) => void;
  /** Planted again after a rejoin when the server lost it (see shouldReplantAfterRejoin) */
  planted?: PlantedPhotoState;
}

/**
 * In-game connection handling. A dropped socket is not the end of the game: socket.io reconnects on its own
 * (and GameContext forces it when the app returns to the foreground), and every reconnect arrives on a new
 * server socket, so we rejoin with the rejoin token; the server answers with a `game-state` snapshot.
 * A planted photo the server lacks (its upload ended offline or before the rejoin bound the new socket) is planted again.
 * Returns whether the socket is connected, to show a "Reconnecting…" indicator meanwhile, and `resync`, which asks the
 * server for the game again on the connected socket (see Server/GAME_FLOW.md, "One socket = one player in one room":
 * the same join on a bound socket is a no-op answered with room-of-game, the game-state snapshot and an awaited
 * your-turn). Offline it sends nothing: the reconnect's rejoin brings the same snapshot.
 */
export const useGameConnection = ({
  socket, gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted,
}: GameConnectionOptions) => {
  const [connected, setConnected] = useState(socket?.connected ?? false);
  // Latest values without re-subscribing the socket listeners
  const latest = useRef({ gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted });
  latest.current = { gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted };

  /** join-create-game for this game's room and name, with its stored rejoin token */
  const joinGame = useCallback(async (target: Socket): Promise<void> => {
    const { gameCode: code, username: name, getRejoinToken: getToken } = latest.current;
    if (!code || !name) return;
    const rejoinToken = await getToken(code, name);
    emitJoin(target, { gameCode: code, username: name, rejoinToken });
  }, []);

  const resync = useCallback(async () => {
    if (!socket?.connected) return;
    console.log("[GAME] Asking the server for the game again");
    await joinGame(socket);
  }, [socket, joinGame]);

  useEffect(() => {
    if (!socket) return;
    setConnected(socket.connected);

    const onConnect = async () => {
      setConnected(true);
      console.log("[GAME] Reconnected — rejoining");
      await joinGame(socket);
    };

    const onDisconnect = (reason: string) => {
      setConnected(false);
      // The server closed this socket on purpose (e.g. the host removed us): socket.io won't reconnect
      if (reason === "io server disconnect") latest.current.onLeave();
      else console.log(`[GAME] Socket disconnected (${reason}) — waiting to reconnect`);
    };

    // A refused connection would keep the "Reconnecting…" indicator forever: leave with the server's reason
    const onConnectError = (err: Error) => {
      if (isConnectionRefused(socket)) latest.current.onLeave(err.message);
    };

    const onRoomOfGame = (data: RoomOfGameResponse) => {
      const { username: name, onLeave: leave, saveRejoinToken: save, planted: plantedPhoto } = latest.current;
      if (!data.success) { leave(data.message); return; }
      if (data.rejoinToken && data.room && name) save(data.room.gameCode, name, data.rejoinToken);
      if (data.room && plantedPhoto && shouldReplantAfterRejoin({
        room: data.room,
        hasPlantedPhoto: !!data.hasPlantedPhoto,
        plantedPhotoUri: plantedPhoto.uri,
        plantedPhotoSent: plantedPhoto.sent,
      })) {
        console.log("[GAME] The server lost my planted photo — planting it again");
        plantedPhoto.plant();
      }
    };

    return attachHandlers(socket, {
      connect: onConnect,
      disconnect: onDisconnect,
      connect_error: onConnectError,
      "room-of-game": onRoomOfGame,
    });
  }, [socket]);

  return { connected, resync };
};

export default useGameConnection;
