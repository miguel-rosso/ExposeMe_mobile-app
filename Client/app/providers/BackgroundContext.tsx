import React, { useState, useRef, useEffect, useContext } from "react";
import { BackgroundContext, backgrounds } from "./BackgroundContextInstance";

export { BackgroundContext };

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
