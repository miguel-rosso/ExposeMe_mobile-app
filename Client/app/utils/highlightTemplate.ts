/** Where a dialog's highlighted text (e.g. a player's name) goes inside its message template */
export const HIGHLIGHT_PLACEHOLDER = "{name}";

export interface HighlightedParts {
  before: string;
  highlight: string;
  after: string;
}

/**
 * Splits a message template around its first {name} so the highlighted text can be painted apart. The text is placed
 * as is (no String.replace pattern, so a `$&` in a name stays literal). Without a placeholder the highlighted text
 * follows the message after a space, so it is never lost.
 */
export function splitHighlightTemplate(template: string, highlight: string): HighlightedParts {
  const at = template.indexOf(HIGHLIGHT_PLACEHOLDER);
  if (at < 0) return { before: `${template} `, highlight, after: "" };
  return { before: template.slice(0, at), highlight, after: template.slice(at + HIGHLIGHT_PLACEHOLDER.length) };
}
