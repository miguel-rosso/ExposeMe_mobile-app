import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { ServerPhase } from "../models/interfaces";

/**
 * QA builds only: development bundles served by a Metro started with EXPO_PUBLIC_QA=1 (as qa/lab/lab.sh does). A release
 * bundle never sends telemetry, even if the variable leaked into its build.
 */
export const isQaTelemetryEnabled = (): boolean => __DEV__ && process.env.EXPO_PUBLIC_QA === "1";

/**
 * Dev/QA render telemetry (EXP-012, Server/GAME_FLOW.md "QA render telemetry"): once the screen has committed a new
 * server phase (a new `phaseKey`), tells the server with `qa-ack { phase, round, at }`, so the lab can measure how far
 * apart the devices render the same phase. One ack per phase start; nothing at all outside QA builds.
 */
export function useQaRenderAck(socket: Socket | null | undefined, phase: ServerPhase | null, round: number, phaseKey: number) {
  const lastAckedKey = useRef<number | null>(null);

  useEffect(() => {
    if (!isQaTelemetryEnabled() || !socket || !phase || lastAckedKey.current === phaseKey) return;
    lastAckedKey.current = phaseKey;
    socket.emit("qa-ack", { phase, round, at: Date.now() });
  }, [socket, phase, round, phaseKey]);
}
