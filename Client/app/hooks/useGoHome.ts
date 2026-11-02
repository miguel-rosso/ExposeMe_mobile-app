import { useRouter } from "expo-router";
import { useGameContext } from "@/app/providers/GameContext";
import { HOME_PATH } from "@/app/utils/homeRoute";

/**
 * Back to the home at the bottom of the stack, closing every screen over it (see homeRoute). `notice` (the server's
 * reason, e.g. a refused join or kicked) is handed to home in memory, which shows it once.
 */
export const useGoHome = (): ((notice?: string) => void) => {
  const router = useRouter();
  const { setHomeNotice } = useGameContext();
  return (notice?: string) => {
    if (notice) setHomeNotice(notice);
    router.dismissTo(HOME_PATH);
  };
};

export default useGoHome;
