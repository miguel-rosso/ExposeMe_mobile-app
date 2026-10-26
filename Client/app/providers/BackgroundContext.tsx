import React, { createContext, useState, useRef, useEffect, useCallback, useContext } from "react";
import { ImageSourcePropType } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useGameContext } from "./GameContext";

import bg1 from "@/assets/images/bg1.jpg";
import bg2 from "@/assets/images/bg2.jpg";
import bg3 from "@/assets/images/bg3.jpeg";
import bg4 from "@/assets/images/bg4.jpg";
import bg5 from "@/assets/images/bg5.jpg";
import bg6 from "@/assets/images/bg6.jpg";

const backgrounds = [bg1, bg2, bg3, bg4, bg5, bg6];

/** Bundled backgrounds are Metro asset ids (see images.d.ts). */
type BackgroundAsset = number;

interface BackgroundContextProps {
  backgroundImage: BackgroundAsset;
  setBackgroundImage: (backgroundImage: BackgroundAsset) => void;
}

export const BackgroundContext = createContext<BackgroundContextProps>({
  backgroundImage: backgrounds[0],
  setBackgroundImage: () => {},
});

export const useBackgroundContext = () => useContext(BackgroundContext);

export const BackgroundProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [backgroundImage, setBackgroundImage] = useState(backgrounds[Math.floor(Math.random() * backgrounds.length)]);
  const availableIndices = useRef([...Array(backgrounds.length).keys()]);

  const getRandomIndex = (indices: number[]): number => {
    const randomIndex = Math.floor(Math.random() * indices.length);
    return indices[randomIndex];
  };

  const changeBackgroundImage = () => {
    if (availableIndices.current.length === 0) {
      availableIndices.current = [...Array(backgrounds.length).keys()];
    }
    const randomIndex = getRandomIndex(availableIndices.current);
    setBackgroundImage(backgrounds[randomIndex]);
    availableIndices.current = availableIndices.current.filter((index) => index !== randomIndex);
  };

  useEffect(() => {
    const interval = setInterval(changeBackgroundImage, 10000);
    return () => clearInterval(interval);
  }, []);

  return <BackgroundContext.Provider value={{ backgroundImage, setBackgroundImage }}>{children}</BackgroundContext.Provider>;
};
