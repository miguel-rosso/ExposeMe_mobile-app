#!/usr/bin/env bash
# Command line of qa/lab/bots.mjs (EXP-197): --help and bad arguments exit before any network activity.
# A local TCP listener stands in for the server and counts connections; nothing else is contacted.
# Run: qa/lab/tests/bots-cli.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOTS="$HERE/../bots.mjs"
TMP="$(mktemp -d)"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# ── Connection-counting listener ──
node -e '
  const net = require("net"); const fs = require("fs");
  let n = 0; const f = process.argv[1];
  const s = net.createServer((c) => { n++; fs.writeFileSync(f + ".count", String(n)); c.destroy(); });
  s.listen(0, "127.0.0.1", () => fs.writeFileSync(f + ".port", String(s.address().port)));
' "$TMP/listener" &
LISTENER=$!
trap 'kill $LISTENER 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do [ -s "$TMP/listener.port" ] && break; sleep 0.1; done
PORT="$(cat "$TMP/listener.port")"
URL="http://127.0.0.1:$PORT"
conns() { cat "$TMP/listener.count" 2>/dev/null || echo 0; }

run() { # expected-rc, label, args...: exit code + stdout/stderr captured, no connection made
  local want=$1 label=$2; shift 2
  out="$(SERVER_URL="$URL" node "$BOTS" "$@" 2>"$TMP/err")"; rc=$?
  err="$(cat "$TMP/err")"
  [ "$rc" = "$want" ] && [ "$(conns)" = 0 ] && ok "$label" || ko "$label" "rc=$rc want=$want conns=$(conns) err=$err"
}

# ── --help ──
run 0 "--help exits 0" --help
[[ "$out" == *"usage: node qa/lab/bots.mjs"* && "$out" == *"--server URL"* ]] && ok "--help prints usage" || ko "--help prints usage" "$out"
run 0 "-h exits 0" -h
run 0 "--help wins over other options" --bots 3 --host --help --server "$URL"

# ── Bad arguments: exit 2 with a message ──
run 2 "unknown option exits 2" --bots 3 --hots
[[ "$err" == *'unknown option "--hots"'* ]] && ok "unknown option is named" || ko "unknown option is named" "$err"
run 2 "option without a value exits 2" --bots 3 --server
[[ "$err" == *'"--server" needs a value'* ]] && ok "missing value is named" || ko "missing value is named" "$err"
run 2 "value swallowed by the next option exits 2" --server --host
run 2 "stray positional exits 2" --host 3
[[ "$err" == *'unexpected argument "3"'* ]] && ok "stray positional is named" || ko "stray positional is named" "$err"

# ── A valid run says which server it uses before connecting ──
SERVER_URL="$URL" node "$BOTS" --bots 1 --host --timeout 1 >/dev/null 2>"$TMP/err"
err="$(cat "$TMP/err")"
[[ "$err" == *"bots.mjs: server $URL (from \$SERVER_URL)"* ]] && ok "prints the server in use" || ko "prints the server in use" "$err"
out="$(node "$BOTS" --bots 1 --host --timeout 1 --server "$URL" 2>&1 >/dev/null)"
[[ "$out" == *"bots.mjs: server $URL"* && "$out" != *"shared lab server"* ]] && ok "--server is printed without the default warning" || ko "--server printed" "$out"

echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
