import { useRouter } from "expo-router";
import { useGameContext } from "@/src/providers/GameContext";
import { HOME_PATH } from "@/src/utils/homeRoute";

/**
 * A room screen's way out (lobby, game): back to the home at the bottom of the stack, closing every screen over it
 * (see homeRoute). The exit is marked for home, which closes the room's socket then (and only then: EXP-373). `notice`
 * (the server's reason, e.g. a refused join or kicked) is handed to home in memory, which shows it once.
 */
export const useGoHome = (): ((notice?: string) => void) => {
  const router = useRouter();
  const { setHomeNotice, markRoomExit } = useGameContext();
  return (notice?: string) => {
    if (notice) setHomeNotice(notice);
    markRoomExit();
    router.dismissTo(HOME_PATH);
  };
};

export default useGoHome;
