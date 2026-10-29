import { createContext } from "react";
import type { GameContextProps } from "@/app/models/interfaces";

// The context object lives in its own rarely edited module: a Fast Refresh of GameContext.tsx re-evaluates that
// module, and creating the context there would hand the mounted provider and the re-evaluated hook different objects.
// Keep it that way: at runtime this file may import only react; types must stay `import type`.
export const GameContext = createContext<GameContextProps | undefined>(undefined);
