import { Player } from "../models/interfaces";

// Room membership updates shared by the screens that keep a players list (player-left / player-removed / new-host).
// A player who is merely disconnected stays in the list: only these events take someone out of the room.

/** Player out of the room (left or kicked) */
export const withoutPlayer = (players: Player[], username: string): Player[] =>
  players.filter((p) => p.username !== username);

/** Host handed over: only `host` keeps the flag */
export const withHost = (players: Player[], host: string): Player[] =>
  players.map((p) => ({ ...p, isHost: p.username === host }));

/** player-connection (lobby): `username` is gone (disconnected past the server's grace) or back */
export const withConnection = (players: Player[], username: string, connected: boolean): Player[] =>
  players.map((p) => (p.username === username ? { ...p, connected } : p));

/** Whether `username` holds the host flag (the host is not always the first player: a gone host hands it over) */
export const isHostIn = (players: Player[], username: string | null | undefined): boolean =>
  players.some((p) => p.username === username && p.isHost);
