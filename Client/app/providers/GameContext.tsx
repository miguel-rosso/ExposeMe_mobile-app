import React, { createContext, useState, useContext } from "react";
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

  const startSocket = () => {
    if (!socket) {
      console.log("Starting socket");
      const newSocket = io(SERVER_URL, { autoConnect: true });
      setSocket(newSocket);
    }
  };

  const endSocket = () => {
    if (socket) {
      console.log("Ending socket");
      socket.disconnect();
      setSocket(null);
    }
  };

  // Function to upload planted photo when game starts
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
      return data.url; // Returns the URL path like /temp/filename.jpg
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
