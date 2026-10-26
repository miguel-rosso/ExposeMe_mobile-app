import { useRef } from "react";
import { PlayerColors, withPlayerColors } from "@/app/utils/playerColors";

/**
 * Each player's colour, fixed for as long as the screen is mounted: players joining get one, players leaving keep
 * theirs reserved, nobody's changes. A device that mounts the screen mid-game (app restarted) works the colours out
 * again from the players there at that moment, so they may differ from the other devices' if someone had left.
 * The map keeps its identity while no new player shows up.
 */
export const usePlayerColors = (players: readonly { username: string }[]): PlayerColors => {
  const assigned = useRef<PlayerColors>(new Map());
  // Idempotent: a repeated render with the same players returns the same map
  assigned.current = withPlayerColors(assigned.current, players.map((p) => p.username));
  return assigned.current;
};
