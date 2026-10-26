import { useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { PhotoUnavailableReason, YourTurnData } from "../models/interfaces";
import { TurnUpload, turnUploadAction } from "../utils/gameState";

/**
 * Events that end my photo request in force (see Server/GAME_FLOW.md, "photo-unavailable", and TURN_ENDING_EVENTS in
 * qa/lab/bots.mjs). Each of their GameScreen handlers calls `endTurn`: a your-turn flow still running (gallery pick,
 * upload retries) then neither sends its photo nor reports it unavailable. On `game-paused` the upload goes on and
 * is re-sent on the resume's your-turn (same attempt).
 */
export const TURN_ENDING_EVENTS = [
  "waiting-photo", "round-start", "round-skipped", "game-paused", "game-state", "game-over",
] as const;

export interface EndTurnOptions {
  /** Keep showing "uploading your photo" (game-paused: the upload goes on; game-over: the final screens cover it). */
  keepUploading?: boolean;
  /**
   * Also forget why I reported my photo unavailable. On a new photo wait (waiting-photo) or a rejoin snapshot
   * (game-state) the round-skipped answering that report has gone by (or was lost while offline): a later skip is
   * someone else's and must show the room's reason, not mine.
   */
  forgetReport?: boolean;
}

/**
 * Lifecycle of my own photo request (`your-turn`): which request is in force, whether I'm picking/uploading for it,
 * the photo uploaded for it (re-sent if the server asks again after a reconnect or a pause) and why I reported it
 * unavailable (for my own round-skipped notice).
 */
export function useTurnRequest(socket: Socket | null | undefined) {
  const [uploading, setUploading] = useState(false);
  // Request of mine in force (last your-turn), null once a TURN_ENDING_EVENT ends it
  const currentRef = useRef<YourTurnData | null>(null);
  // Photo uploaded (or being uploaded) for a request: re-sent if the server asks again
  const uploadRef = useRef<TurnUpload | null>(null);
  // Why I reported photo-unavailable, until round-skipped takes it (or a new wait / snapshot forgets it)
  const reportedRef = useRef<PhotoUnavailableReason | null>(null);

  const actions = useMemo(() => {
    // A your-turn flow can outlive its request: only the request in force may send or report anything
    const isCurrent = (turn: YourTurnData) => currentRef.current?.attempt === turn.attempt;

    /** New your-turn (or a re-send of the same one). Returns true when a photo must be picked and uploaded. */
    const start = (turn: YourTurnData): boolean => {
      currentRef.current = turn;
      setUploading(true);
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
      setUploading(false);
      socket?.emit("photo-unavailable", { round: turn.round, attempt: turn.attempt });
    };

    /** A TURN_ENDING_EVENT arrived: any request of mine is over. */
    const endTurn = ({ keepUploading = false, forgetReport = false }: EndTurnOptions = {}) => {
      currentRef.current = null;
      if (!keepUploading) setUploading(false);
      if (forgetReport) reportedRef.current = null;
    };

    /** Why I reported this turn unavailable (null if I didn't), cleared once taken. */
    const takeReportedReason = (): PhotoUnavailableReason | null => {
      const reason = reportedRef.current;
      reportedRef.current = null;
      return reason;
    };

    return { isCurrent, start, sendPhoto, reportUnavailable, endTurn, takeReportedReason };
  }, [socket]);

  return { uploading, ...actions };
}
