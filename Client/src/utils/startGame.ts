import type { Player } from "../models/interfaces";
import type { Translations } from "../i18n/context";
import { AckSocket, emitAwaitingAck, hasBooleanOk } from "./socketAck";

/** How long the host's Start waits for start-game's ack before giving up (the button is usable again). */
export const START_ACK_TIMEOUT_MS = 5000;

/** Fewest players a game starts with (the server refuses start-game with fewer, see Server/GAME_FLOW.md). */
const MIN_PLAYERS_TO_START = 2;

/**
 * Why the server refused start-game (see Server/GAME_FLOW.md, "Start acknowledgement"): the socket is in no room
 * (e.g. rejoining), the sender is not the host (the role was handed over), a game is already running, or fewer than 2
 * players are left once the gone ones were removed (named in `removed`).
 */
export type StartRefusal = "not-in-room" | "not-host" | "already-started" | "not-enough-players";
export type StartGameAck =
  | { ok: true }
  | { ok: false; reason: "not-enough-players"; removed: string[] }
  | { ok: false; reason: Exclude<StartRefusal, "not-enough-players"> };

const isStartGameAck = (answer: unknown): answer is StartGameAck => hasBooleanOk(answer);

/** Sends start-game and resolves with the server's ack, or null when none came (see emitAwaitingAck). */
export const sendStartGame = (socket: AckSocket, timeoutMs = START_ACK_TIMEOUT_MS): Promise<StartGameAck | null> =>
  emitAwaitingAck(socket, "start-game", [], isStartGameAck, { timeoutMs });

/**
 * The host is offered Start with at least 2 players not shown as gone: the server removes gone players at the start
 * (EXP-129), so counting them would offer a start it refuses.
 */
export const canOfferStart = (players: Player[]): boolean =>
  players.filter((p) => p.connected !== false).length >= MIN_PLAYERS_TO_START;

type StartNoticeTexts = Pick<
  Translations,
  "startRefusedPlayerGone" | "startRefusedPlayersGone" | "startRefusedNotEnoughPlayers" | "startGameFailed"
>;

/**
 * What to tell the host after a start that didn't happen: who was removed for being gone, too few players, or a
 * generic failure (no answer, the role moved, rejoining). Null when there is nothing to say: started, or a game is
 * already running (its screen follows).
 */
export function startNoticeText(ack: StartGameAck | null, t: StartNoticeTexts): string | null {
  if (ack?.ok || ack?.reason === "already-started") return null;
  if (ack?.reason !== "not-enough-players") return t.startGameFailed;
  const { removed } = ack;
  // A replacer function: a name is inserted as is, never read as a `$&` / `$'` replacement pattern
  if (removed.length === 1) return t.startRefusedPlayerGone.replace("{name}", () => removed[0]);
  return removed.length > 1 ? t.startRefusedPlayersGone : t.startRefusedNotEnoughPlayers;
}
