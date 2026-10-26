// Each player's colour in a game (EXP-253), worked out from the names alone: every device draws the same colours
// without the server sending them.

/** One colour per seat (a room holds up to 12 players). Mid tones, away from the reveal's green and red */
export const PLAYER_PALETTE = [
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#cbd5e1", // slate
  "#d946ef", // fuchsia
  "#06b6d4", // cyan
  "#fb7185", // rose
  "#facc15", // yellow
] as const;

/** Text drawn over a palette colour: dark, readable on all of them (WCAG contrast >= 3.9) */
export const PLAYER_COLOR_INK = "#111827";

/** Colour of each player, by username */
export type PlayerColors = ReadonlyMap<string, string>;

// 32-bit FNV-1a over UTF-16 code units: cheap, well spread, and the same on every JS engine
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const hashName = (name: string) => {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

/**
 * Gives a colour to the names that don't have one yet; the ones already given never change, even when their player
 * has left (their colour stays reserved). Each new name prefers the palette slot its hash points to and takes the next
 * free one when that is in use, so up to 12 players never share a colour. New names are visited in code-unit order
 * (not the locale's), so devices that saw the same players get the same colours. Returns `assigned` itself when every
 * name already has a colour.
 */
export const withPlayerColors = (assigned: PlayerColors, names: readonly string[]): PlayerColors => {
  const newNames = [...new Set(names)].filter((name) => !assigned.has(name)).sort();
  if (newNames.length === 0) return assigned;
  const colors = new Map(assigned);
  const taken = new Set<number>([...assigned.values()].map((color) => PLAYER_PALETTE.indexOf(color as typeof PLAYER_PALETTE[number])));
  for (const name of newNames) {
    let slot = hashName(name) % PLAYER_PALETTE.length;
    // Past a full palette colours repeat instead of looping forever
    while (taken.has(slot) && taken.size < PLAYER_PALETTE.length) slot = (slot + 1) % PLAYER_PALETTE.length;
    taken.add(slot);
    colors.set(name, PLAYER_PALETTE[slot]);
  }
  return colors;
};

/** The colours of a room seen for the first time */
export const playerColors = (names: readonly string[]): PlayerColors => withPlayerColors(new Map(), names);

// ── Initial ──
// What follows a base character inside one user-perceived character: combining marks, variation selectors, emoji skin
// tones, tag characters (subdivision flags) and the keycap mark, or a zero-width joiner and the character it joins
const GRAPHEME_EXTENSION =
  "[\\u0300-\\u036F\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20FF\\uFE00-\\uFE0F\\uFE20-\\uFE2F\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}]|\\u200D.";
// A flag (pair of regional indicators), or one character with its extensions
const FIRST_GRAPHEME = new RegExp(`^(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|.(?:${GRAPHEME_EXTENSION})*)`, "u");

/** The first user-perceived character of a text: Intl.Segmenter where the engine has it, else the pattern above */
export const firstGrapheme = (text: string): string => {
  if (typeof Intl.Segmenter === "function") {
    const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    return first?.segment ?? "";
  }
  return text.match(FIRST_GRAPHEME)?.[0] ?? "";
};

/**
 * The first character of a name (a whole emoji or flag, not part of it), for the player's avatar. Upper-cased only when
 * that keeps it one character ("ß" would become "SS")
 */
export const playerInitial = (name: string) => {
  const initial = firstGrapheme(name.trim());
  if (!initial) return "?";
  const upper = initial.toUpperCase();
  return firstGrapheme(upper) === upper ? upper : initial;
};
