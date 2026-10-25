import React, { createContext, useState, useContext, useRef, useEffect } from "react";
import { AppState } from "react-native";
import { io, Socket } from "socket.io-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GameContextProps, GameProviderProps, Player } from "@/app/models/interfaces";
import getEnvVars from "@/config";
import { uploadPhoto } from "@/app/utils/uploadPhoto";

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
  const [plantedPhotoUri, setPlantedPhotoUri] = useState<string | null>(null);
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
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current = newSocket;
    setSocket(newSocket);
  };

  const endSocket = () => {
    console.log("Ending socket");
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setSocket(null);
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

  const uploadPlantedPhoto = async (): Promise<string | null> => {
    if (!plantedPhotoUri) return null;

    try {
      return await uploadPhoto(SERVER_URL, plantedPhotoUri);
    } catch (error) {
      console.error("Error uploading planted photo:", error);
      return null;
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
        setGameCode,
        setUsername,
        setPlayersProvider,
        setRoundsOfGame,
        plantedPhotoUri,
        setPlantedPhotoUri,
        uploadPlantedPhoto,
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
