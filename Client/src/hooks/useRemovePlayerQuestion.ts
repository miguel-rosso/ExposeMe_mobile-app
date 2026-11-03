import { useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import { Player } from "../models/interfaces";
import { emitWhileConnected } from "../utils/socketEmit";

/**
 * The host's "remove this player?" question during the game (EXP-425). `asking` is the player it asks about, only
 * while they are still in `players` and `open` (the game is on): a leave or another kick meanwhile, or game over,
 * closes it on its own. It stays open across phases (the scoreboard that opened it lasts 5 s).
 * `ask` is stable, for the memoised scoreboard. Remove sends remove-player (offline it is not sent: the player stays
 * on screen, so the host can ask again once reconnected).
 */
export const useRemovePlayerQuestion = (socket: Socket | null, players: readonly Player[], open: boolean) => {
  const [asked, setAsked] = useState<string | null>(null);
  const asking = open && asked !== null && players.some((p) => p.username === asked) ? asked : null;
  const ask = useCallback((username: string) => setAsked(username), []);
  const cancel = useCallback(() => setAsked(null), []);
  const confirm = (username: string) => {
    setAsked(null);
    emitWhileConnected(socket, "remove-player", { username });
  };
  return { asking, ask, confirm, cancel };
};
