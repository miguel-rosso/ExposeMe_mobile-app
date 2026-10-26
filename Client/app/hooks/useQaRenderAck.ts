import { useCallback, useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { ServerPhase } from "../models/interfaces";
import { emitWhileConnected } from "../utils/socketEmit";

/**
 * QA builds only: development bundles served by a Metro started with EXPO_PUBLIC_QA=1 (as qa/lab/lab.sh does). A release
 * bundle never sends telemetry, even if the variable leaked into its build.
 */
export const isQaTelemetryEnabled = (): boolean => __DEV__ && process.env.EXPO_PUBLIC_QA === "1";

/** Records that the socket handler of an event starting `phase` is running now (call it first thing in the handler). */
export type MarkPhaseHandled = (phase: ServerPhase) => void;

/**
 * Dev/QA render telemetry (EXP-012, Server/GAME_FLOW.md "QA render telemetry"): once the screen has committed a new
 * server phase (a new `phaseKey`), tells the server with `qa-ack { phase, round, at, handledAt? }`, so the lab can
 * measure how far apart the devices render the same phase. One ack per phase start; nothing at all outside QA builds.
 *
 * Returns `markHandled`, for the socket handlers of the events that start a phase (EXP-223): the ack of that phase then
 * also carries `handledAt`, the device time its handler started, so the lab can split the delay into delivery
 * (server emit → handler) and handler → paint. A phase started any other way (resume, rejoin, hold) has no `handledAt`.
 */
export function useQaRenderAck(
  socket: Socket | null | undefined, phase: ServerPhase | null, round: number, phaseKey: number,
): MarkPhaseHandled {
  const lastAckedKey = useRef<number | null>(null);
  const handled = useRef<{ phase: ServerPhase; at: number } | null>(null);

  const markHandled = useCallback<MarkPhaseHandled>((handledPhase) => {
    if (isQaTelemetryEnabled()) handled.current = { phase: handledPhase, at: Date.now() };
  }, []);

  useEffect(() => {
    if (!isQaTelemetryEnabled() || !socket || !phase || lastAckedKey.current === phaseKey) return;
    lastAckedKey.current = phaseKey;
    const handledAt = handled.current?.phase === phase ? handled.current.at : undefined;
    handled.current = null; // one ack per handled event: a later restart of the phase has none
    // A phase rendered offline is not acked (a late ack would be dropped before the rejoin, and measure nothing)
    emitWhileConnected(socket, "qa-ack", { phase, round, at: Date.now(), ...(handledAt !== undefined && { handledAt }) });
  }, [socket, phase, round, phaseKey]);

  return markHandled;
}
