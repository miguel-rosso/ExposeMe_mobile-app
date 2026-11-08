import type { Player, Room } from "../models/interfaces";

// ── Recent lobby chat ──
// The app has no message ids: it reports a chat bubble (report-content, EXP-423) by its author and text. The server
// keeps each room's last CHAT_LOG_SIZE relayed messages in memory, with the players who were in the room when each was
// sent, only to check that such a message was really sent in the reporter's room by that player while the reporter
// was there: nobody can file a report about words someone never wrote, nor one who joined later about what was said
// before. A room's log goes with the room (WeakMap), and nothing of it is ever written anywhere.

/**
 * Messages kept per room, oldest dropped first. A bubble is on screen for under 6 s and the reason picker takes a
 * few more: at the chat's rate limit one player needs 25 s of non-stop messages to push a reported one out.
 */
export const CHAT_LOG_SIZE = 100;

interface LoggedMessage {
  username: string;
  message: string;
  /** The room's players when it was sent, by seat (a rejoin keeps the same Player) */
  audience: ReadonlySet<Player>;
}

export function createChatLog(size = CHAT_LOG_SIZE) {
  const logs = new WeakMap<Room, LoggedMessage[]>();
  return {
    /** `username` sent `message` to the rest of `room`, exactly as relayed in chat-message, heard by its players now. */
    record(room: Room, username: string, message: string): void {
      const log = logs.get(room) ?? [];
      log.push({ username, message, audience: new Set(room.players) });
      if (log.length > size) log.splice(0, log.length - size);
      logs.set(room, log);
    },
    /** `username` sent exactly `message` in `room` among its last `size` messages, while `listener` was in the room. */
    heardBy(room: Room, username: string, message: string, listener: Player): boolean {
      return logs.get(room)?.some((m) => m.username === username && m.message === message && m.audience.has(listener))
        ?? false;
    },
  };
}

export type ChatLog = ReturnType<typeof createChatLog>;
