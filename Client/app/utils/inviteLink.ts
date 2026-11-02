// ── Waiting room: what an invite link does ──
// The waiting room opens from home (Create game, Search room), from the game screen ("Play again", the next game) and
// from an invite deep link, which may also reach a waiting room that is already open (its `code` changes).

/**
 * Where the waiting room stands:
 * - `idle`: not in any room yet (just opened, or its invite dialog asks before anything joined);
 * - `lobby`: it started (or reused) the socket of its own room and shows that room's lobby;
 * - `overRoomScreen`: an invite link opened it over the room's own screen (e.g. mid-game), which keeps the room and
 *   its socket: it never joins from that socket, it only goes back to that screen or, on Join, replaces it;
 * - `left`: it gave way to another screen (or unmounted): nothing may join or leave from it any more.
 */
export type WaitingRoomMode = "idle" | "lobby" | "overRoomScreen" | "left";

/**
 * What the waiting room does with its link: `ask` (the invite dialog, DEC-046), `backToRoomScreen`, `startLobby`
 * (start or reuse the socket of the room it knows, closing any invite dialog), `newRoomOrHome` (no room code: a new
 * room if home's Create game asked for one, else home), or `none`.
 */
export type LinkStep = "none" | "ask" | "backToRoomScreen" | "startLobby" | "newRoomOrHome";

export interface LinkInput {
  /** The link's valid room code, or null (no link, or a malformed code) */
  linkedCode: string | null;
  /** The room the app knows (GameContext's gameCode), or null */
  roomCode: string | null;
  /**
   * Whether the room's own screen (the game screen) is right under this one: only a link pushes the waiting room over
   * it. The app's own ways in replace it (Play again, the next game) or start from home (Create game, Search room).
   */
  roomScreenBelow: boolean;
  mode: WaitingRoomMode;
}

/**
 * The step for the waiting room's link, and its mode after it (DEC-047: a link to another room only asks; the room the
 * player is in stays as it is until Join). A link to the room we are in rejoins it, unless that room's own screen is
 * under this one: then it goes back to it, as it does for a link without a valid code or without any (it never joins
 * from that screen's socket: EXP-363). A lobby (or its dialog over the room's screen) ignores a link without a valid
 * code (e.g. the one Cancel clears).
 */
export const linkStep = ({ linkedCode, roomCode, roomScreenBelow, mode }: LinkInput): { step: LinkStep; mode: WaitingRoomMode } => {
  if (mode === "left") return { step: "none", mode };
  const opensOverRoomScreen = mode === "idle" && roomScreenBelow;
  const nextMode = opensOverRoomScreen ? "overRoomScreen" : mode;
  if (linkedCode && linkedCode !== roomCode) return { step: "ask", mode: nextMode };
  if (nextMode === "overRoomScreen") {
    return { step: linkedCode || opensOverRoomScreen ? "backToRoomScreen" : "none", mode: nextMode };
  }
  if (mode === "lobby") return { step: linkedCode ? "startLobby" : "none", mode };
  return { step: roomCode ? "startLobby" : "newRoomOrHome", mode };
};
