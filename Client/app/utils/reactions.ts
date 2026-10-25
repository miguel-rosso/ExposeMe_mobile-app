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
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
