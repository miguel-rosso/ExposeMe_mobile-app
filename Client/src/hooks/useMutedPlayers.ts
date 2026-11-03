import { useCallback, useSyncExternalStore } from "react";

// Muting another player is local to this device (EXP-422, DEC-052 A): their chat, emoji reactions and round photos are
// hidden here only, nothing is sent to the server. A mute lasts for the player's stay in the room: the lobby and the
// game screen share it, and it survives reconnecting, even on a new socket (e.g. "Play again" while reconnecting). The
// stay ends when the app's room changes (GameContext's setGameCode calls endMutesOutsideRoom): every way out of the
// room (Exit, kicked, room gone, an invite link's Join) forgets the room, so joining it again starts with nobody muted.

/** The players muted on this device, by name (names are unique in a room) */
export type MutedNames = ReadonlySet<string>;

export const NOBODY_MUTED: MutedNames = new Set<string>();

/** The room stay the mutes belong to (null: none yet), and the players muted in it */
let mutes: { room: string | null; names: MutedNames } = { room: null, names: NOBODY_MUTED };
const listeners = new Set<() => void>();

const setMutes = (room: string | null, names: MutedNames) => {
  mutes = { room, names };
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The players muted in `room`: the same set until a mute changes, for the memoised rows and lanes */
const mutedIn = (room: string | null): MutedNames => (room !== null && mutes.room === room ? mutes.names : NOBODY_MUTED);

/** The app's room is now `room` (null: none): a stay in any other room is over, and its mutes are forgotten */
export const endMutesOutsideRoom = (room: string | null) => {
  if (mutes.room !== room && mutes.names.size > 0) setMutes(null, NOBODY_MUTED);
};

/** `list` without the items of muted players; the same list when none is, so nothing re-renders */
export const withoutMuted = <T extends { username: string }>(list: T[], muted: MutedNames): T[] =>
  list.some((item) => muted.has(item.username)) ? list.filter((item) => !muted.has(item.username)) : list;

/**
 * The players this device muted in `room` (the game context's room code), and `toggle` to mute or unmute one (stable
 * for a room). Without a room nobody is muted and `toggle` does nothing.
 */
export const useMutedPlayers = (room: string | null) => {
  const muted = useSyncExternalStore(subscribe, () => mutedIn(room));
  const toggle = useCallback((username: string) => {
    if (room === null) return;
    const names = new Set(mutedIn(room));
    if (!names.delete(username)) names.add(username);
    setMutes(room, names);
  }, [room]);
  return { muted, toggle };
};
