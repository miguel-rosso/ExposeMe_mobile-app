import { MAX_USERNAME_LENGTH } from "./playerName";
import type { Player } from "../models/interfaces";

// ── Content reports (report-content, EXP-423) ──
// A player reports another player's round photo or chat message, with a reason. Only the reported content comes in
// the payload; the reporter and the room come from the socket's session, and the report must point at something the
// server itself showed in that room: a round photo the reporter was shown, or a message still in the room's chat log
// (managers/chatLog). What is stored about it is written by managers/reportStore.

export const REPORT_KINDS = ["photo", "message"] as const;
/** The app's reason picker: «Contenido sexual / Violencia o odio / Acoso / Otro» (Client/src/utils/contentReport.ts) */
export const REPORT_REASONS = ["sexual", "violence", "harassment", "other"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];

/** report-content's payload as sent; any other field (a gameCode or reporter name) is never read. */
export interface ReportContentData {
  kind: unknown;
  reason: unknown;
  /** kind "photo": the round whose photo it is (round-start's `round`) */
  round?: unknown;
  /** kind "message": the bubble's author and text, exactly as chat-message relayed them */
  author?: unknown;
  text?: unknown;
}

/** A well-formed report: what it points at, and why. */
export type ParsedReport =
  | { kind: "photo"; reason: ReportReason; round: number }
  | { kind: "message"; reason: ReportReason; author: string; text: string };

/** Why a report was refused: no room session, a malformed payload, or nothing of that by another player there. */
export type ReportRefusal = "not-in-room" | "invalid" | "not-found";
/** report-content's acknowledgement. */
export type ReportContentAck = { ok: true } | { ok: false; reason: ReportRefusal };

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The report in `data`, or null when its kind, reason or target is malformed. A message's text is only bounded by the
 * chat log it must match exactly (messages there are at most the chat's MAX_CHAT_LENGTH).
 */
export function parseReport(data: ReportContentData): ParsedReport | null {
  const { kind, reason, round, author, text } = data;
  if (!isOneOf(REPORT_KINDS, kind) || !isOneOf(REPORT_REASONS, reason)) return null;
  if (kind === "photo") {
    return Number.isInteger(round) && (round as number) >= 1 ? { kind, reason, round: round as number } : null;
  }
  if (!isNonEmptyString(author) || author.length > MAX_USERNAME_LENGTH || !isNonEmptyString(text)) return null;
  return { kind, reason, author, text };
}

/** A round photo as the room was shown it (GameEngine.shownPhoto). */
export interface ShownPhoto {
  /** Its `/temp/<name>` path */
  photo: string;
  /** Who uploaded or planted it */
  owner: string;
  /**
   * The players in the room at its round-start, the ones it was shown to: by their seat (a rejoin keeps the same
   * Player), so someone who joined later under a name that was there then is not one of them
   */
  viewers: ReadonlySet<Player>;
}

/** What the reporter's room knows about the reported content (see resolveReport). */
export interface ReportLookups {
  shownPhoto: (round: number) => ShownPhoto | undefined;
  /** `author` sent exactly `text` in the room's recent chat while the reporter was in the room */
  heardByReporter: (author: string, text: string) => boolean;
}

/** The reported content, once found in the reporter's room. */
export interface ReportedContent {
  /** The round of a photo; null for a message */
  round: number | null;
  /** The player who sent it */
  reported: string;
  /** A message's text; null for a photo */
  text: string | null;
  /** A photo's `/temp/<name>` path; null for a message */
  photo: string | null;
}

/**
 * The content `report` points at in the reporter's room, or null when there is none: a round never shown to
 * `reporter`, a message not in the room's recent chat or sent before they were in the room, or content of their own.
 */
export function resolveReport(report: ParsedReport, reporter: Player, lookups: ReportLookups): ReportedContent | null {
  if (report.kind === "photo") {
    const shown = lookups.shownPhoto(report.round);
    if (!shown || shown.owner === reporter.username || !shown.viewers.has(reporter)) return null;
    return { round: report.round, reported: shown.owner, text: null, photo: shown.photo };
  }
  if (report.author === reporter.username || !lookups.heardByReporter(report.author, report.text)) return null;
  return { round: null, reported: report.author, text: report.text, photo: null };
}

/** What a report is about, the same for every report of that content in a game (one report per player each). */
export const contentKey = (content: ReportedContent): string =>
  content.round !== null ? `photo:${content.round}` : `message:${content.reported}\n${content.text}`;
