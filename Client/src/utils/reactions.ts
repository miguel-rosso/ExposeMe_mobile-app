// In-game emoji reactions and lobby chat: what the client accepts from the room and how much it keeps on screen.

// The picker's emojis; any other reaction from the room is ignored
export const REACTION_EMOJIS = ["😂", "😍", "❓", "😳", "🔥", "😭", "🤡", "😡"] as const;
// Sent when a player takes a screenshot; shown with a translated label instead of the bare emoji
export const SCREENSHOT_EMOJI = "📸";

export const MAX_VISIBLE_REACTIONS = 5;
export const MAX_CHAT_MESSAGES = 50;

export function isAllowedReaction(emoji: unknown): emoji is string {
  return typeof emoji === "string" && (emoji === SCREENSHOT_EMOJI || (REACTION_EMOJIS as readonly string[]).includes(emoji));
}

// Appends `item` and keeps only the newest `max` (oldest dropped first)
export function appendCapped<T>(list: T[], item: T, max: number): T[] {
  return appendAllCapped(list, [item], max);
}

// Appends `items` (in order) and keeps only the newest `max` (oldest dropped first)
export function appendAllCapped<T>(list: T[], items: T[], max: number): T[] {
  const next = [...list, ...items];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ── Room reactions on screen ──

/** One room reaction in the game screen's lane, until its animation ends or newer ones push it out */
export interface RoomReaction {
  id: string;
  username: string;
  emoji: string;
  /** The round photo it was sent on: it is only ever shown over that one */
  photo: string;
}

/**
 * The reaction to show over `photo` for an `emoji-reaction` event, or null when it is not one the picker could have
 * sent or no photo is shown
 */
export function roomReactionOf(data: unknown, photo: string | null): RoomReaction | null {
  const { username, emoji } = (data ?? {}) as { username?: unknown; emoji?: unknown };
  if (!photo || !isAllowedReaction(emoji) || typeof username !== "string") return null;
  return { id: `${Date.now()}-${Math.random()}`, username, emoji, photo };
}

/** The reactions sent on `photo`; the same list when they all were */
export function reactionsOn(list: RoomReaction[], photo: string | null): RoomReaction[] {
  return list.every((r) => r.photo === photo) ? list : list.filter((r) => r.photo === photo);
}

/** The list without reaction `id`; the same list when it is not there (an evicted reaction ending), so nothing renders */
export function withoutReaction(list: RoomReaction[], id: string): RoomReaction[] {
  return list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : list;
}
