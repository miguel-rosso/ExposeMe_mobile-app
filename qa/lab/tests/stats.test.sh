#!/usr/bin/env bash
# qa/lab/stats.mjs (EXP-236): the nearest-rank percentile shared by bots.mjs and render-skew.mjs.
# Run: qa/lab/tests/stats.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATS="$HERE/../stats.mjs"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3] got [$2]"; fi; } # name, actual, expected
pct() { # p, values... -> percentile as JSON
  node --input-type=module -e '
    const { percentile } = await import(process.argv[1]);
    const [p, ...xs] = process.argv.slice(2).map(Number);
    console.log(JSON.stringify(percentile(xs, p)));
  ' "$STATS" "$@"
}

# ── percentile ──
check "no values -> null" "$(pct 50)" "null"
check "one value is every percentile" "$(pct 95 7)" "7"
check "p50 of 2 is the lower one (nearest rank)" "$(pct 50 10 20)" "10"
check "p50 of 4 is the 2nd" "$(pct 50 4 3 2 1)" "2"
check "p50 of 5 is the median" "$(pct 50 5 1 4 2 3)" "3"
check "unsorted input" "$(pct 50 30 10 20)" "20"
check "p95 of 20 is the 19th" "$(pct 95 $(seq 1 20))" "19"
check "p95 of 19 is the max" "$(pct 95 $(seq 1 19))" "19"
check "p95 of 21 is the 20th" "$(pct 95 $(seq 1 21))" "20"
check "p100 is the max" "$(pct 100 3 9 1)" "9"
check "p0 is the min" "$(pct 0 3 9 1)" "1"
out="$(node --input-type=module -e '
  const { percentile } = await import(process.argv[1]);
  const xs = [3, 1, 2]; percentile(xs, 50); console.log(xs.join(","));
' "$STATS")"
check "input is not reordered" "$out" "3,1,2"

# ── Both reports use it (no private percentile left) ──
for f in bots.mjs render-skew.mjs; do
  grep -q 'from "./stats.mjs"' "$HERE/../$f" && ! grep -qE 'function percentile|const pct' "$HERE/../$f" \
    && ok "$f uses the shared percentile" || ko "$f uses the shared percentile"
done

echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
