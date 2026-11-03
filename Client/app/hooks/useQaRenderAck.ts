import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import type { Socket } from "socket.io-client";
import type { ServerPhase } from "../models/interfaces";
import { isRemoteUri } from "../utils/image";
import { emitWhileConnected } from "../utils/socketEmit";

/**
 * QA builds only: development bundles served by a Metro started with EXPO_PUBLIC_QA=1 (as qa/lab/lab.sh does). A release
 * bundle never sends telemetry, even if the variable leaked into its build.
 */
export const isQaTelemetryEnabled = (): boolean => __DEV__ && process.env.EXPO_PUBLIC_QA === "1";

/** Records that the socket handler of an event starting `phase` is running now (call it first thing in the handler). */
export type MarkPhaseHandled = (phase: ServerPhase) => void;

/** Device time each phase's handler ran, not acked yet, in the order they ran (a Map keeps insertion order) */
type PendingMarks = Map<ServerPhase, number>;

/**
 * Takes the handler time of `phase` for its ack, if its handler ran. That mark and every older one are used up: a mark
 * older than the phase now painted belongs to a phase that was never painted on its own (its render was batched with
 * the next one), so it must not tag a later resumed start of it. Newer marks stay: the next event's handler can run
 * before this phase's ack (the ack effect runs after paint, EXP-266), and its own ack still needs its mark.
 */
function takeMark(marks: PendingMarks, phase: ServerPhase): number | undefined {
  const handledAt = marks.get(phase);
  if (handledAt === undefined) return undefined;
  for (const marked of [...marks.keys()]) {
    marks.delete(marked);
    if (marked === phase) break;
  }
  return handledAt;
}

// ── Painted round (for the photo-shown ack) ──

interface PaintedRound {
  socket: Socket;
  phase: ServerPhase;
  round: number;
}

/**
 * The phase and round the game screen has painted last, while it shows one (QA builds only). The round photo is drawn
 * by PhotoComponent, which gets only the photo from the game screen: its photo-shown ack reads the round from here.
 * There is one game screen at a time.
 */
let paintedRound: PaintedRound | null = null;

/**
 * Dev/QA render telemetry (EXP-012, Server/GAME_FLOW.md "QA render telemetry"): once the screen has committed a new
 * server phase (a new `phaseKey`), tells the server with `qa-ack { phase, round, at, platform, handledAt? }`, so the
 * lab can measure how far apart the devices render the same phase. One ack per phase start; nothing at all outside QA
 * builds.
 *
 * Returns `markHandled`, for the socket handlers of the events that start a phase (EXP-223): the ack of that phase then
 * also carries `handledAt`, the device time its handler started, so the lab can split the delay into delivery
 * (server emit → handler) and handler → paint. A phase started any other way (resume, rejoin, hold) has no `handledAt`.
 */
export function useQaRenderAck(
  socket: Socket | null | undefined, phase: ServerPhase | null, round: number, phaseKey: number,
): MarkPhaseHandled {
  const lastAckedKey = useRef<number | null>(null);
  const pendingMarks = useRef<PendingMarks>(new Map());

  const markHandled = useCallback<MarkPhaseHandled>((handledPhase) => {
    if (!isQaTelemetryEnabled()) return;
    pendingMarks.current.delete(handledPhase); // re-inserted last: the newest mark
    pendingMarks.current.set(handledPhase, Date.now());
  }, []);

  useEffect(() => {
    if (!isQaTelemetryEnabled() || !socket || !phase || lastAckedKey.current === phaseKey) return;
    lastAckedKey.current = phaseKey;
    const handledAt = takeMark(pendingMarks.current, phase); // one ack per handled event: a later restart has none
    // A phase rendered offline is not acked (a late ack would be dropped before the rejoin, and measure nothing)
    emitWhileConnected(socket, "qa-ack", {
      phase, round, at: Date.now(), platform: Platform.OS, ...(handledAt !== undefined && { handledAt }),
    });
  }, [socket, phase, round, phaseKey]);

  useEffect(() => {
    if (!isQaTelemetryEnabled() || !socket || !phase) return;
    const painted = { socket, phase, round };
    paintedRound = painted;
    return () => {
      if (paintedRound === painted) paintedRound = null;
    };
  }, [socket, phase, round]);

  return markHandled;
}

/** How the main round photo first ended up: drawn, or impossible to draw (no photo on screen) */
export type PhotoOutcome = "shown" | "failed";

/**
 * QA photo telemetry (EXP-395, Server/GAME_FLOW.md "QA render telemetry"): the phase ack says when the answering screen
 * was painted, but the photo may still be downloading and decoding then. Returns the reporter for the main photo's
 * first outcome: it tells the server with `qa-photo-shown { phase, round, at, platform, failed? }` (the phase and round
 * the game screen has painted), once per photo; later loads of the same photo are not reported. Only server photos
 * shown by the game screen are reported (not the own-photos viewer's), and nothing at all outside QA builds.
 */
export function useQaPhotoShownAck(photoUrl: string): (outcome: PhotoOutcome) => void {
  const reportedUrl = useRef<string | null>(null);
  return useCallback((outcome) => {
    if (!isQaTelemetryEnabled() || !paintedRound || !isRemoteUri(photoUrl) || reportedUrl.current === photoUrl) return;
    reportedUrl.current = photoUrl;
    const { socket, phase, round } = paintedRound;
    emitWhileConnected(socket, "qa-photo-shown", {
      phase, round, at: Date.now(), platform: Platform.OS, ...(outcome === "failed" && { failed: true }),
    });
  }, [photoUrl]);
}
