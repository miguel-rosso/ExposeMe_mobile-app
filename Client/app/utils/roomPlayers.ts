import { Player } from "../models/interfaces";

// Room membership updates shared by the screens that keep a players list (player-left / player-removed / new-host).
// A player who is merely disconnected stays in the list: only these events take someone out of the room.

/** Player out of the room (left or kicked) */
export const withoutPlayer = (players: Player[], username: string): Player[] =>
  players.filter((p) => p.username !== username);

/** Host handed over: only `host` keeps the flag */
export const withHost = (players: Player[], host: string): Player[] =>
  players.map((p) => ({ ...p, isHost: p.username === host }));
