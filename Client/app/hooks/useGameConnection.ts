import { useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import { RoomOfGameResponse } from "../models/interfaces";
import { attachHandlers } from "../utils/socketHandlers";
import { shouldReplantAfterRejoin } from "../utils/plantedPhoto";

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
 * A planted photo the server lost meanwhile (sent offline, or before the rejoin bound the new socket) is planted again.
 * Returns whether the socket is connected, to show a "Reconnecting…" indicator meanwhile.
 */
export const useGameConnection = ({
  socket, gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted,
}: GameConnectionOptions) => {
  const [connected, setConnected] = useState(socket?.connected ?? false);
  // Latest values without re-subscribing the socket listeners
  const latest = useRef({ gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted });
  latest.current = { gameCode, username, getRejoinToken, saveRejoinToken, onLeave, planted };

  useEffect(() => {
    if (!socket) return;
    setConnected(socket.connected);

    const onConnect = async () => {
      setConnected(true);
      const { gameCode: code, username: name, getRejoinToken: getToken } = latest.current;
      if (!code || !name) return;
      const rejoinToken = await getToken(code, name);
      console.log("[GAME] Reconnected — rejoining");
      socket.emit("join-create-game", { gameCode: code, username: name, ...(rejoinToken ? { rejoinToken } : {}) });
    };

    const onDisconnect = (reason: string) => {
      setConnected(false);
      // The server closed this socket on purpose (e.g. the host removed us): socket.io won't reconnect
      if (reason === "io server disconnect") latest.current.onLeave();
      else console.log(`[GAME] Socket disconnected (${reason}) — waiting to reconnect`);
    };

    // The server refused the connection itself (e.g. "Too many connections"): socket.io won't retry that, so the
    // "Reconnecting…" indicator would stay forever. Network errors leave the socket active and it keeps retrying.
    const onConnectError = (err: Error) => {
      if (!socket.active) latest.current.onLeave(err.message);
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

  return { connected };
};

export default useGameConnection;
