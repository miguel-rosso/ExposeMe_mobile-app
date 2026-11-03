import { useEffect, useMemo, useRef } from "react";
import type { Socket } from "socket.io-client";
import { RoundView } from "../utils/roundState";
import { emitWhileConnected } from "../utils/socketEmit";

/** Minimum time (ms) between two submit-answer sends (server: 10 per socket, refilled 5/s, see GAME_FLOW "Answers") */
export const PICK_SEND_INTERVAL = 200;

/** What the sender reads from the round, always the latest state (GameScreen's roundRef) */
export type PickRound = Pick<RoundView, "mySelection" | "round" | "phase">;

/**
 * Sends my pick (`submit-answer`) to the server, which keeps the last one while answering (EXP-148).
 * Rapid taps are coalesced: at most one send per PICK_SEND_INTERVAL, then a trailing send of the latest pick, so the
 * server's per-socket rate limit never drops the pick that counts. A trailing send whose answering phase is over by
 * then (reveal, a new round or photo wait) is dropped: that pick can't count; so is one still waiting on unmount.
 * A pick is only emitted while connected: one made offline goes from the rejoin's snapshot (`resendAfterRejoin`).
 */
export function usePickSender(socket: Socket | null | undefined, roundRef: { readonly current: PickRound }) {
  const lastSentAtRef = useRef(0);
  // Trailing send of the latest pick, waiting for its throttle slot
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (trailingRef.current) clearTimeout(trailingRef.current); }, []);

  return useMemo(() => {
    /** Sends the current pick now; a trailing send still waiting is no longer needed */
    const sendNow = () => {
      if (trailingRef.current) clearTimeout(trailingRef.current);
      trailingRef.current = null;
      lastSentAtRef.current = Date.now();
      emitWhileConnected(socket, "submit-answer", { guess: roundRef.current.mySelection });
    };

    /** My pick changed: sent now if its throttle slot is free, else by the trailing send (which takes the latest) */
    const pickChanged = () => {
      if (trailingRef.current) return;
      const wait = lastSentAtRef.current + PICK_SEND_INTERVAL - Date.now();
      if (wait <= 0) { sendNow(); return; }
      const pickRound = roundRef.current.round;
      trailingRef.current = setTimeout(() => {
        const { round, phase } = roundRef.current;
        if (round === pickRound && phase === "answering") sendNow();
        else trailingRef.current = null;
      }, wait);
    };

    /** The answer bar ended: a pick waiting for its throttle slot leaves at once (within the server's ANSWER_GRACE) */
    const flushPending = () => { if (trailingRef.current) sendNow(); };

    /** A rejoin snapshot of answering: my current pick, if any, again (one sent while offline was dropped) */
    const resendAfterRejoin = () => { if (roundRef.current.mySelection) sendNow(); };

    return { pickChanged, flushPending, resendAfterRejoin };
  }, [socket, roundRef]);
}
