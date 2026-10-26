// Shared statistics for the lab's reports (bots.mjs, render-skew.mjs), so the numbers `lab.sh` prints side by side
// mean the same thing (EXP-236).

/**
 * Nearest-rank percentile (p in 0..100) of `values` (any order; not modified): the smallest value with at least p% of
 * the values at or below it. p95 of fewer than 20 values is the max. null when there are no values.
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
