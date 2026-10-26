import React, { createContext, useState, useContext, useRef, useEffect } from "react";
import { AppState } from "react-native";
import { io, Socket } from "socket.io-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GameContextProps, GameProviderProps, PlantUploadState, Player } from "@/app/models/interfaces";
import getEnvVars from "@/config";
import { uploadPhoto } from "@/app/utils/uploadPhoto";
import { PLANT_UPLOAD_RETRY, uploadWithRetry } from "@/app/utils/uploadRetry";
import { leaveAndClose } from "@/app/utils/leaveRoom";

const { SERVER_URL } = getEnvVars();
const REJOIN_TOKEN_KEY = "rejoinToken";

interface StoredRejoinToken {
  gameCode: string;
  username: string;
  token: string;
}

const GameContext = createContext<GameContextProps | undefined>(undefined);

export const GameProvider: React.FC<GameProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameCode, setGameCode] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [playersProvider, setPlayersProvider] = useState<Player[]>([]);
  const [roundsOfGame, setRoundsOfGame] = useState<number>(5);
  // Photo picked in the lobby to plant in this game (dropped when the game/room ends), and whether the server has it
  const [plantedPhotoUri, setPlantedPhotoUriState] = useState<string | null>(null);
  const [plantedPhotoSent, setPlantedPhotoSent] = useState(false);
  const [plantUpload, setPlantUpload] = useState<PlantUploadState>("idle");
  const plantedUriRef = useRef<string | null>(null);
  const plantingRef = useRef<string | null>(null); // uri being uploaded (one upload per picked photo at a time)
  const socketRef = useRef<Socket | null>(null);
  const rejoinTokenRef = useRef<StoredRejoinToken | null>(null);

  // ── Rejoin token (server requires it to reconnect with an existing username) ──

  const saveRejoinToken = (code: string, name: string, token: string) => {
    const entry = { gameCode: code, username: name, token };
    rejoinTokenRef.current = entry;
    AsyncStorage.setItem(REJOIN_TOKEN_KEY, JSON.stringify(entry)).catch(() => {});
  };

  const getRejoinToken = async (code: string, name: string): Promise<string | null> => {
    let entry = rejoinTokenRef.current;
    if (!entry) {
      try {
        const raw = await AsyncStorage.getItem(REJOIN_TOKEN_KEY);
        entry = raw ? (JSON.parse(raw) as StoredRejoinToken) : null;
        rejoinTokenRef.current = entry;
      } catch {
        entry = null;
      }
    }
    return entry && entry.gameCode === code && entry.username === name ? entry.token : null;
  };

  const clearRejoinToken = () => {
    rejoinTokenRef.current = null;
    AsyncStorage.removeItem(REJOIN_TOKEN_KEY).catch(() => {});
  };

  const startSocket = () => {
    // If we already have a connected socket, reuse it
    if (socketRef.current?.connected) {
      setSocket(socketRef.current);
      return;
    }

    // Clean up old socket if it exists but is disconnected
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
    }

    console.log("Starting socket");
    const newSocket = io(SERVER_URL, {
      autoConnect: true,
      reconnection: true,
      // Keep trying: the server keeps the player (and pauses a 2-player game for 5 min) until they rejoin
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = newSocket;
    setSocket(newSocket);
  };

  /**
   * Leaving the game flow (Exit, back home, kicked, room gone): the socket is no longer the app's and none of its
   * listeners runs again. A planted photo is for one game only. Game over keeps the socket open; "Play again" drops
   * the planted photo itself. Returns the detached socket (still open) for the caller to close.
   */
  const detachSocket = (): Socket | null => {
    setPlantedPhotoUri(null);
    const detached = socketRef.current;
    detached?.removeAllListeners();
    socketRef.current = null;
    setSocket(null);
    return detached;
  };

  const endSocket = () => {
    console.log("Ending socket");
    detachSocket()?.disconnect();
  };

  // Exit (and an invite link to another room): the server removes us and hands the host role over, and the rejoin
  // token for this room is forgotten. The app moves on at once; the old socket closes once the server confirms.
  const leaveRoom = () => {
    console.log("Leaving room");
    clearRejoinToken();
    const leaving = detachSocket();
    if (leaving) leaveAndClose(leaving);
  };

  // Handle app going to background/foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && socketRef.current && !socketRef.current.connected) {
        console.log("App resumed — socket disconnected, reconnecting...");
        socketRef.current.connect();
      }
    });
    return () => sub.remove();
  }, []);

  // ── Planted photo ──

  const setPlantedPhotoUri = (uri: string | null) => {
    plantedUriRef.current = uri;
    setPlantedPhotoUriState(uri);
    setPlantedPhotoSent(false);
    setPlantUpload("idle");
  };

  /**
   * Upload the picked planted photo and send plant-photo, right away from the lobby (so im-ready never waits for
   * it), retrying while the server is busy. Returns true once the server has it (plantedPhotoSent: the lobby shows
   * it planted only then). A photo replaced or dropped while uploading is not sent nor retried.
   */
  const plantPhoto = async (): Promise<boolean> => {
    const uri = plantedUriRef.current;
    // The server only accepts uploads from a member of the room (room code + rejoin token)
    const entry = rejoinTokenRef.current;
    if (!uri || !entry || plantingRef.current === uri) return false;
    plantingRef.current = uri;
    setPlantedPhotoSent(false); // (re)planting: the server doesn't have it
    setPlantUpload("uploading");
    const auth = { gameCode: entry.gameCode, token: entry.token };
    const stillPicked = () => plantedUriRef.current === uri;
    try {
      const url = await uploadWithRetry(
        uri,
        (photoUri) => uploadPhoto(SERVER_URL, photoUri, auth, stillPicked),
        PLANT_UPLOAD_RETRY,
        stillPicked,
      );
      if (!stillPicked() || !socketRef.current) return false;
      socketRef.current.emit("plant-photo", { photoUrl: url });
      setPlantedPhotoSent(true);
      setPlantUpload("idle");
      return true;
    } catch (error) {
      // Not console.error: development builds would show it as a toast (the game screen retries after im-ready)
      console.log("Planted photo not uploaded:", error);
      if (stillPicked()) setPlantUpload("failed"); // a replaced photo's upload just stops
      return false;
    } finally {
      if (plantingRef.current === uri) plantingRef.current = null;
    }
  };

  return (
    <GameContext.Provider
      value={{
        socket,
        gameCode,
        username,
        playersProvider,
        roundsOfGame,
        startSocket,
        endSocket,
        leaveRoom,
        setGameCode,
        setUsername,
        setPlayersProvider,
        setRoundsOfGame,
        plantedPhotoUri,
        setPlantedPhotoUri,
        plantedPhotoSent,
        plantUpload,
        plantPhoto,
        saveRejoinToken,
        getRejoinToken,
        clearRejoinToken,
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

export const useGameContext = () => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error("useGameContext must be used within a GameProvider");
  }
  return context;
};
