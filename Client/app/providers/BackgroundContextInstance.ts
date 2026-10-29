import { createContext } from "react";

import bg1 from "@/assets/images/bg1.jpg";
import bg2 from "@/assets/images/bg2.jpg";
import bg3 from "@/assets/images/bg3.jpeg";
import bg4 from "@/assets/images/bg4.jpg";
import bg5 from "@/assets/images/bg5.jpg";
import bg6 from "@/assets/images/bg6.jpg";

/** Bundled backgrounds are Metro asset ids (see images.d.ts). */
export type BackgroundAsset = number;

export const backgrounds: BackgroundAsset[] = [bg1, bg2, bg3, bg4, bg5, bg6];

export interface BackgroundContextProps {
  backgroundImage: BackgroundAsset;
  setBackgroundImage: (backgroundImage: BackgroundAsset) => void;
}

// The context object lives in its own rarely edited module: a Fast Refresh of BackgroundContext.tsx re-evaluates that
// module, and creating the context there would hand the mounted provider and the re-evaluated hook different objects.
// Keep it that way: at runtime this file may import only react and the bundled bg assets; types must stay `import type`.
export const BackgroundContext = createContext<BackgroundContextProps>({
  backgroundImage: backgrounds[0],
  setBackgroundImage: () => {},
});
