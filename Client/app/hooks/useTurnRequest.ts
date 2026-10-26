import { useMemo, useRef } from "react";
import type { Socket } from "socket.io-client";
import { PhotoUnavailableReason, YourTurnData } from "../models/interfaces";
import { TurnUpload, turnUploadAction } from "../utils/gameState";

/**
 * Events that end my photo request in force (see Server/GAME_FLOW.md, "photo-unavailable", and TURN_ENDING_EVENTS in
 * qa/lab/bots.mjs). Each of their GameScreen handlers calls `endTurn`: a your-turn flow still running (gallery pick,
 * upload retries) then neither sends its photo nor reports it unavailable. `waiting-photo`, `round-start`,
 * `round-skipped`, `game-over` and a snapshot of a running game (`game-state`) end the request: its upload retries
 * stop too. `game-paused` (and a `game-state` of a paused game) only suspend it: the pick, upload and retries go on,
 * and the photo is re-sent on the resume's your-turn (same attempt) without a new upload.
 */
export const TURN_ENDING_EVENTS = [
  "waiting-photo", "round-start", "round-skipped", "game-paused", "game-state", "game-over",
] as const;

export interface EndTurnOptions {
  /**
   * Also forget why I reported my photo unavailable. On a new photo wait (waiting-photo) or a rejoin snapshot
   * (game-state) the round-skipped answering that report has gone by (or was lost while offline): a later skip is
   * someone else's and must show the room's reason, not mine.
   */
  forgetReport?: boolean;
  /**
   * Paused, not over (game-paused, or a game-state snapshot of a paused game): the server still accepts my upload, so
   * the request's upload and its retries go on; nothing is sent until the resume's your-turn (same attempt) asks again.
   */
  suspended?: boolean;
}

/**
 * Lifecycle of my own photo request (`your-turn`): which request is in force, the photo uploaded for it (re-sent if
 * the server asks again after a reconnect or a pause) and why I reported it unavailable (for my own round-skipped
 * notice). Nothing here is shown while the request runs: my turn must not show on screen (EXP-252).
 */
export function useTurnRequest(socket: Socket | null | undefined) {
  // Request of mine in force (last your-turn), null once a TURN_ENDING_EVENT ends it
  const currentRef = useRef<YourTurnData | null>(null);
  // Request of mine suspended by a pause: its upload goes on, to be re-sent on the resume's your-turn
  const suspendedRef = useRef<YourTurnData | null>(null);
  // Photo uploaded (or being uploaded) for a request: re-sent if the server asks again
  const uploadRef = useRef<TurnUpload | null>(null);
  // Why I reported photo-unavailable, until round-skipped takes it (or a new wait / snapshot forgets it)
  const reportedRef = useRef<PhotoUnavailableReason | null>(null);

  const actions = useMemo(() => {
    // A your-turn flow can outlive its request: only the request in force may send or report anything
    const isCurrent = (turn: YourTurnData) => currentRef.current?.attempt === turn.attempt;
    // Paused, not over: its photo is still wanted (uploaded now, sent when the resume asks for it again)
    const isSuspended = (turn: YourTurnData) => suspendedRef.current?.attempt === turn.attempt;

    /** New your-turn (or a re-send of the same one). Returns true when a photo must be picked and uploaded. */
    const start = (turn: YourTurnData): boolean => {
      currentRef.current = turn;
      suspendedRef.current = null;
      reportedRef.current = null;
      const action = turnUploadAction(uploadRef.current, turn.attempt);
      if (action === "resend") { socket?.emit("photo-sent", { photo: uploadRef.current!.url }); return false; }
      if (action === "wait") return false; // the upload in flight sends it
      uploadRef.current = { attempt: turn.attempt };
      return true;
    };

    /** The photo for `turn` is uploaded: kept for a re-sent your-turn, sent if its request is still in force. */
    const sendPhoto = (turn: YourTurnData, url: string) => {
      if (uploadRef.current?.attempt === turn.attempt) uploadRef.current = { attempt: turn.attempt, url };
      if (isCurrent(turn)) socket?.emit("photo-sent", { photo: url });
    };

    /** No photo to send for `turn`: tell the server so it skips now instead of making everyone wait. */
    const reportUnavailable = (reason: PhotoUnavailableReason, turn: YourTurnData) => {
      if (uploadRef.current?.attempt === turn.attempt) uploadRef.current = null;
      if (!isCurrent(turn)) { console.log(`[GAME] stale turn ${turn.attempt} ended without a photo (${reason})`); return; }
      console.log(`[GAME] photo-unavailable (${reason})`);
      reportedRef.current = reason;
      socket?.emit("photo-unavailable", { round: turn.round, attempt: turn.attempt });
    };

    /** A TURN_ENDING_EVENT arrived: no request of mine is in force; a pause only suspends it (`suspended`). */
    const endTurn = ({ forgetReport = false, suspended = false }: EndTurnOptions = {}) => {
      // A second pause event (game-state while paused) keeps the request already suspended
      suspendedRef.current = suspended ? currentRef.current ?? suspendedRef.current : null;
      currentRef.current = null;
      if (forgetReport) reportedRef.current = null;
    };

    /** Why I reported this turn unavailable (null if I didn't), cleared once taken. */
    const takeReportedReason = (): PhotoUnavailableReason | null => {
      const reason = reportedRef.current;
      reportedRef.current = null;
      return reason;
    };

    return { isCurrent, isSuspended, start, sendPhoto, reportUnavailable, endTurn, takeReportedReason };
  }, [socket]);

  return actions;
}
