import React, { createContext, useState, useContext, useRef, useEffect } from "react";
import { AppState } from "react-native";
import { io, Socket } from "socket.io-client";
import { GameContextProps, GameProviderProps, Player } from "@/app/models/interfaces";
import getEnvVars from "@/config";

const { SERVER_URL } = getEnvVars();

const GameContext = createContext<GameContextProps | undefined>(undefined);

export const GameProvider: React.FC<GameProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [gameCode, setGameCode] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [playersProvider, setPlayersProvider] = useState<Player[]>([]);
  const [roundsOfGame, setRoundsOfGame] = useState<number>(5);
  const [plantedPhotoUri, setPlantedPhotoUri] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

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
      const formData = new FormData();
      formData.append("image", {
        uri: plantedPhotoUri,
        name: "planted-photo.jpg",
        type: "image/jpeg",
      } as any);

      const response = await fetch(`${SERVER_URL}/upload`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }
      const data = await response.json();
      return data.url;
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
