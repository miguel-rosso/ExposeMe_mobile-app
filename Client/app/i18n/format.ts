/**
 * Fills a translation's `{key}` placeholders in one pass. The replacer function inserts values verbatim: a value
 * (e.g. a player name) with `$&` or `$1` (String.replace patterns) or with another `{key}` placeholder is never expanded.
 * Unknown placeholders are left as they are.
 */
export const fillTemplate = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);
