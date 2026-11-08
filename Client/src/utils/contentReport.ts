import { AckSocket, emitAwaitingAck, hasBooleanOk } from "./socketAck";
import { inRoundPhase, isRevealedOwner, RoundView } from "./roundState";

// Reporting a round photo or another player's chat message (EXP-423, DEC-052 A), see Server/GAME_FLOW.md "Reports".

/** How long a report waits for the server's ack before telling the player it couldn't be sent. */
export const REPORT_ACK_TIMEOUT_MS = 5000;

/**
 * The reasons of the picker, in its order: «Contenido sexual / Violencia o odio / Acoso / Otro». The server's
 * REPORT_REASONS (Server/managers/contentReports.ts); qa/lab/tests/protocol-constants.test.sh checks the copy.
 */
export const REPORT_REASONS = ["sexual", "violence", "harassment", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * What is being reported: the photo of round `round` (`owner`: whose it is, once revealed; unknown while answering),
 * or a chat bubble, named by its author and text as the server relayed them (chat messages have no ids).
 */
export type ReportTarget =
  | { kind: "photo"; round: number; owner?: string }
  | { kind: "message"; author: string; text: string };

/** Why the server refused a report: not in a room (rejoining), a malformed report, or nothing of that there. */
export type ReportRefusal = "not-in-room" | "invalid" | "not-found";
export type ReportContentAck = { ok: true } | { ok: false; reason: ReportRefusal };

const isReportContentAck = (answer: unknown): answer is ReportContentAck => hasBooleanOk(answer);

/** report-content's payload: only the reported content and the reason (the server takes reporter and room from the session). */
export const reportPayload = (target: ReportTarget, reason: ReportReason) =>
  target.kind === "photo"
    ? { kind: target.kind, round: target.round, reason }
    : { kind: target.kind, author: target.author, text: target.text, reason };

/** The player who sent the reported content, when this device knows it (a photo's owner only after its reveal). */
export const reportedPlayer = (target: ReportTarget): string | undefined =>
  target.kind === "photo" ? target.owner : target.author;

/**
 * `target` with its photo's owner when it was picked before the reveal and `onScreen` (what can be reported now) is the
 * same round's photo, revealed since; `target` itself otherwise.
 */
export const withRevealedOwner = (target: ReportTarget, onScreen: ReportTarget | null): ReportTarget => {
  const revealedSince = target.kind === "photo" && target.owner === undefined && onScreen?.kind === "photo"
    && onScreen.round === target.round && onScreen.owner !== undefined;
  return revealedSince ? { ...target, owner: onScreen.owner } : target;
};

/**
 * The player muted for me by reporting `target` (EXP-438): the one who sent it, when this device knows who it is, and
 * never me; null otherwise (a photo before its reveal).
 */
export const playerMutedByReport = (target: ReportTarget, myUsername: string | null): string | null => {
  const reported = reportedPlayer(target);
  return reported !== undefined && reported !== myUsername ? reported : null;
};

/** What the game screen shows of the round (its RoundView) */
type RoundOnScreen = Pick<RoundView, "photo" | "round" | "phase" | "correctAnswer">;

/**
 * The report of the round photo on screen, or null when there is none to report: no photo, a phase without it, or a
 * photo revealed as mine. Its owner once revealed (reveal, scores), so reporting it mutes them (EXP-438).
 */
export const roundPhotoReport = (
  { photo, round, phase, correctAnswer }: RoundOnScreen, username: string | null,
): ReportTarget | null => {
  if (!photo || !inRoundPhase(phase) || isRevealedOwner(correctAnswer, username)) return null;
  return { kind: "photo", round, ...(correctAnswer ? { owner: correctAnswer } : {}) };
};

/**
 * What an answer to a report means for the player: sent; refused for good ("not-found": nothing of that by another
 * player in the room any more, e.g. my own photo or a message gone from the server's recent chat; "invalid"), where
 * trying again can't help; or failed (no answer, offline, rejoining), where it may.
 */
export type ReportOutcome = "sent" | "refused" | "failed";

export const reportOutcome = (ack: ReportContentAck | null): ReportOutcome => {
  if (ack?.ok) return "sent";
  return ack?.reason === "not-found" || ack?.reason === "invalid" ? "refused" : "failed";
};

/** Sends report-content and resolves with the server's ack, or null when none came (see emitAwaitingAck). */
export const sendContentReport = (
  socket: AckSocket, target: ReportTarget, reason: ReportReason, timeoutMs = REPORT_ACK_TIMEOUT_MS,
): Promise<ReportContentAck | null> =>
  emitAwaitingAck(socket, "report-content", [reportPayload(target, reason)], isReportContentAck, { timeoutMs });
