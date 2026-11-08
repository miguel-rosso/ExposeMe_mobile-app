/**
 * Fills a translation's `{key}` placeholders in one pass. The replacer function inserts values verbatim: a value
 * (e.g. a player name) with `$&` or `$1` (String.replace patterns) or with another `{key}` placeholder is never expanded.
 * Unknown placeholders are left as they are.
 */
export const fillTemplate = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);

/** A piece of a translation split at its placeholders: plain text, or the key of a `{key}` placeholder. */
export type TemplatePart = { text: string } | { placeholder: string };

/**
 * Splits a translation at its `{key}` placeholders, in order, so each placeholder can be rendered as its own element
 * (e.g. a link inside a sentence). Empty text between adjacent placeholders is dropped.
 */
export const splitTemplate = (template: string): TemplatePart[] =>
  template
    .split(/\{(\w+)\}/)
    .flatMap((piece, i): TemplatePart[] => (i % 2 === 1 ? [{ placeholder: piece }] : piece ? [{ text: piece }] : []));
