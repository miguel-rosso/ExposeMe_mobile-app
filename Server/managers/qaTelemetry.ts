import { appendFileSync } from "fs";
import { RoundPhase } from "../models/interfaces";

// ── QA render telemetry (dev/QA only, EXP-012) ──
// QA builds of the app (EXPO_PUBLIC_QA=1) send `qa-ack { phase, round, at, handledAt? }` once they have rendered a new
// phase. With QA_TELEMETRY=1 the server records when each ack arrived and when it emitted that phase, one JSON line per
// ack, so the lab can measure how far apart the devices render the same phase, how long each phase event took to reach
// each device and how long the device took from its handler to the paint (EXP-223). Off by default: production
// registers no handler at all.

/**
 * A qa-ack payload: the phase the device rendered, its round and the device clock (ms) when it did; `handledAt` is the
 * device clock when its socket handler received the event that started that phase (absent for a resumed phase).
 */
export interface QaAck {
  phase: RoundPhase;
  round: number;
  at: number;
  handledAt?: number;
}

/**
 * One recorded ack: the payload plus who sent it (from the session), the server clock when it arrived and, if that phase
 * of that round is the room's latest broadcast, the server clock when it was emitted (`serverAt`).
 */
export interface QaAckRecord extends QaAck {
  gameCode: string;
  username: string;
  receivedAt: number;
  serverAt?: number;
}

export interface QaTelemetry {
  record(entry: QaAckRecord): void;
}

// A device acks 3–4 phases per round (more after a reconnect or resume); a flood is dropped
export const QA_ACK_BURST = 10;
export const QA_ACK_RATE_PER_S = 2;
// Far above any real game (20 rounds plus skips), keeps junk out of the log
const MAX_ACK_ROUND = 1_000;
const QA_PHASES: ReadonlySet<unknown> = new Set<RoundPhase>(["waiting-photo", "answering", "reveal", "scores"]);

export function isQaAck(data: unknown): data is QaAck {
  if (typeof data !== "object" || data === null) return false;
  const { phase, round, at, handledAt } = data as Record<string, unknown>;
  return QA_PHASES.has(phase)
    && Number.isInteger(round) && (round as number) >= 0 && (round as number) <= MAX_ACK_ROUND
    && isFiniteNumber(at) && (handledAt === undefined || isFiniteNumber(handledAt));
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Appends one JSON line to `file`. Synchronous on purpose (dev/QA only, a few lines per round): lines keep the order the
 * acks arrived in, and are on disk once record() returns. A failed write is logged, never thrown into the handler.
 */
function appendJsonLine(file: string, entry: QaAckRecord): void {
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
