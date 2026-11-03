#!/usr/bin/env bash
# The lab's shell tests themselves (EXP-408): they run under `set -o pipefail`, where a pipe into an early-exiting grep
# (-q / --quiet stops at the first match) fails now and then although the line is there: its writer gets SIGPIPE
# (141) when it writes after grep has gone. So no test script pipes into one; they grep a file or a here-string.
# Run: qa/lab/tests/test-scripts.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# early_exit_pipes FILE... -> "<file>:<line>:<text>" of each line (comments aside) that pipes into grep -q / --quiet
# (a `|` that is not half of `||`: `cmd || grep -q` is no pipe)
early_exit_pipes() {
  grep -nHE '(^|[^|])\|[[:space:]]*grep[[:space:]]+(-[[:alnum:]]*q|--quiet)' "$@" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'
}

# ── The checker ──
SAMPLE="$HERE/fixtures/test-scripts/pipes.sh"
flagged="$(early_exit_pipes "$SAMPLE" | sed -E 's/^[^:]*:([0-9]+):.*/\1/' | tr '\n' ' ')"
[ "$flagged" = "2 4 6 " ] \
  && ok "checker flags pipes into grep -q (also on a continuation line), not other greps, || greps, comments or here-strings" \
  || ko "checker flags only pipes into grep -q" "flagged lines: $flagged"

# ── The lab's tests ──
found="$(early_exit_pipes "$HERE"/*.sh)"
[ -z "$found" ] && ok "no lab test pipes into grep -q under pipefail" || ko "no lab test pipes into grep -q" "$found"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
