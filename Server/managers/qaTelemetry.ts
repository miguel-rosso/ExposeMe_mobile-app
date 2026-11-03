import { appendFileSync } from "fs";
import { RoundPhase } from "../models/interfaces";

// ── QA render telemetry (dev/QA only, EXP-012) ──
// QA builds of the app (EXPO_PUBLIC_QA=1) send `qa-ack { phase, round, at, platform, handledAt? }` once they have
// rendered a new phase. With QA_TELEMETRY=1 the server records when each ack arrived and when it emitted that phase, one JSON line per
// ack, so the lab can measure how far apart the devices render the same phase, how long each phase event took to reach
// each device and how long the device took from its handler to the paint (EXP-223). They also send
// `qa-photo-shown { phase, round, at, platform, failed? }` once the round photo is on screen (EXP-395), recorded the
// same way with `kind: "photo-shown"`, so the lab can measure the photo's download and decode too. Off by default:
// production registers no handler at all.

/** The platforms the app runs on: the lab reports per platform how long the round photo takes to show (EXP-395) */
export type QaPlatform = "ios" | "android";

/** What both QA events carry: a round phase and its round, a device clock time (ms) and the device's platform */
interface QaPhaseEvent {
  phase: RoundPhase;
  round: number;
  at: number;
  platform: QaPlatform;
}

/**
 * A qa-ack payload: the phase the device rendered, its round and the device clock when it did; `handledAt` is the
 * device clock when its socket handler received the event that started that phase (absent for a resumed phase).
 */
export interface QaAck extends QaPhaseEvent {
  handledAt?: number;
}

/**
 * One recorded ack: the payload plus who sent it (from the session), the server clock when it arrived and, if that phase
 * of that round was broadcast once and within the last PHASE_EMIT_ROUNDS_KEPT rounds, the server clock when it was
 * emitted (`serverAt`).
 */
export interface QaAckRecord extends QaAck {
  gameCode: string;
  username: string;
  receivedAt: number;
  serverAt?: number;
}

/**
 * A qa-photo-shown payload: the phase and round the device had painted, and its clock, when the main round photo first
 * drew; `failed` when it could not be drawn at all (the device then shows no photo).
 */
export interface QaPhotoShown extends QaPhaseEvent {
  failed?: true;
}

/** One recorded qa-photo-shown: the payload, who sent it (from the session) and the server clock when it arrived. */
export interface QaPhotoShownRecord extends QaPhotoShown {
  kind: "photo-shown";
  gameCode: string;
  username: string;
  receivedAt: number;
}

export type QaTelemetryRecord = QaAckRecord | QaPhotoShownRecord;

export interface QaTelemetry {
  record(entry: QaTelemetryRecord): void;
}

// A device acks 3–4 phases per round and one photo (more after a reconnect or resume); a flood is dropped. Both QA
// events share one budget per socket.
export const QA_ACK_BURST = 10;
export const QA_ACK_RATE_PER_S = 2;
// Far above any real game (20 rounds plus skips), keeps junk out of the log
const MAX_ACK_ROUND = 1_000;
const QA_PHASES: ReadonlySet<unknown> = new Set<RoundPhase>(["waiting-photo", "answering", "reveal", "scores"]);
const QA_PLATFORMS: ReadonlySet<unknown> = new Set<QaPlatform>(["ios", "android"]);

/** The fields both QA events carry (QaPhaseEvent) */
const isQaPhaseEvent = (data: Record<string, unknown>): boolean =>
  QA_PHASES.has(data.phase)
  && Number.isInteger(data.round) && (data.round as number) >= 0 && (data.round as number) <= MAX_ACK_ROUND
  && isFiniteNumber(data.at) && QA_PLATFORMS.has(data.platform);

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null;

export function isQaAck(data: unknown): data is QaAck {
  return isRecord(data) && isQaPhaseEvent(data) && (data.handledAt === undefined || isFiniteNumber(data.handledAt));
}

export function isQaPhotoShown(data: unknown): data is QaPhotoShown {
  return isRecord(data) && isQaPhaseEvent(data) && (data.failed === undefined || data.failed === true);
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Appends one JSON line to `file`. Synchronous on purpose (dev/QA only, a few lines per round): lines keep the order the
 * acks arrived in, and are on disk once record() returns. A failed write is logged, never thrown into the handler.
 */
function appendJsonLine(file: string, entry: QaTelemetryRecord): void {
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error("qa-ack write error:", (err as Error).message);
  }
}

/**
 * The telemetry sink when QA_TELEMETRY=1, else null. Records go to QA_TELEMETRY_FILE (JSON lines), or to the console
 * when no file is set.
 */
export function createQaTelemetry(env: NodeJS.ProcessEnv = process.env): QaTelemetry | null {
  if (env.QA_TELEMETRY !== "1") return null;
  const file = env.QA_TELEMETRY_FILE;
  return {
    record: (entry) => (file ? appendJsonLine(file, entry) : console.log(`[qa-ack] ${JSON.stringify(entry)}`)),
  };
}
