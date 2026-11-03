import React, { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useIsFocused } from "expo-router";
import {
  BackgroundContext,
  backgrounds,
  type BackgroundContextProps,
  type BackgroundStore,
} from "./BackgroundContextInstance";

export { BackgroundContext };

/** How long each background stays before the next one replaces it */
export const BACKGROUND_ROTATION_MS = 10000;

const randomItem = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const allBackgroundIndices = () => [...Array(backgrounds.length).keys()];
const backgroundIndicesOtherThan = (index: number) => allBackgroundIndices().filter((other) => other !== index);

/**
 * The shared background: it starts on a random one and, while at least one focused screen shows it, moves every
 * BACKGROUND_ROTATION_MS to another random one, going through them all before repeating. Each rotation shows a
 * different background: the one on screen is never drawn again, neither at the start nor when a new round begins.
 * While no screen shows it (e.g. the game screen is on top) it stays still.
 */
const createBackgroundStore = (): BackgroundStore => {
  let currentIndex = randomItem(allBackgroundIndices());
  let notShownYet = backgroundIndicesOtherThan(currentIndex);
  const listeners = new Set<() => void>();
  let viewers = 0;
  let rotation: ReturnType<typeof setInterval> | undefined;

  const showNextBackground = () => {
    if (notShownYet.length === 0) notShownYet = backgroundIndicesOtherThan(currentIndex);
    currentIndex = randomItem(notShownYet);
    notShownYet = notShownYet.filter((index) => index !== currentIndex);
    listeners.forEach((listener) => listener());
  };

  const show = () => {
    viewers += 1;
    if (viewers === 1) rotation = setInterval(showNextBackground, BACKGROUND_ROTATION_MS);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      viewers -= 1;
      if (viewers === 0) clearInterval(rotation);
    };
  };

  const subscribe = (onChange: () => void) => {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  };

  return { getBackgroundImage: () => backgrounds[currentIndex], subscribe, show };
};

const ignoreChanges = () => () => {};

/**
 * The background for the calling screen. Only while the screen is focused does it keep the background rotating and
 * re-render with it: kept mounted under another screen (home under the lobby and the game) it stays still, and it
 * catches up with the current background once focused again.
 */
export const useBackgroundContext = (): BackgroundContextProps => {
  const store = useContext(BackgroundContext);
  const focused = useIsFocused();

  useEffect(() => (focused ? store.show() : undefined), [store, focused]);

  const subscribe = useCallback(
    (onChange: () => void) => (focused ? store.subscribe(onChange) : ignoreChanges()),
    [store, focused]
  );
  const backgroundImage = useSyncExternalStore(subscribe, store.getBackgroundImage);

  return useMemo(() => ({ backgroundImage }), [backgroundImage]);
};

export const BackgroundProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [store] = useState(createBackgroundStore);
  return <BackgroundContext.Provider value={store}>{children}</BackgroundContext.Provider>;
};
