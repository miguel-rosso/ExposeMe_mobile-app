#!/usr/bin/env bash
# qa/lab/link-proxy.mjs (EXP-437), the proxy `lab.sh play` puts between one Android device's adb reverse and the lab
# server to cut that device's link mid-game: its command line, then real sockets (link-proxy-check.mjs): HTTP and a
# socket.io client (websocket) through it, a cut drops the connection in flight on both ends and refuses new ones for
# its seconds while a player not behind it stays, the link comes back on its own (or on POST /restore) and the client
# reconnects, the control's answers and the event log. Against an in-process socket.io server on a free port; set
# LINK_PROXY_SERVER_PORT=<port> to also run the checks against a running lab server (qa/lab/lab.sh server --port 3105).
# Run: qa/lab/tests/link-proxy.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="$HERE/../link-proxy.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# ── Command line ──
node "$PROXY" --ports-file "$TMP/p.json" >"$TMP/out" 2>&1; rc=$?
[ $rc = 2 ] && grep -q -- "--target needs a port" "$TMP/out" && ok "no --target: exit 2 with the usage" \
  || ko "no --target: exit 2" "rc=$rc $(cat "$TMP/out")"
node "$PROXY" --target 3000 >"$TMP/out" 2>&1; rc=$?
[ $rc = 2 ] && grep -q -- "--ports-file is required" "$TMP/out" && ok "no --ports-file: exit 2" \
  || ko "no --ports-file: exit 2" "rc=$rc $(cat "$TMP/out")"
node "$PROXY" --target 3000 --ports-file "$TMP/p.json" --bogus 1 >"$TMP/out" 2>&1; rc=$?
[ $rc = 2 ] && grep -q -- "bad argument --bogus" "$TMP/out" && ok "unknown option: exit 2" \
  || ko "unknown option: exit 2" "rc=$rc $(cat "$TMP/out")"
[ ! -e "$TMP/p.json" ] && ok "a refused command line listens on nothing (no ports file)" || ko "no ports file on bad arguments"

# ── Real sockets ──
run_checks() { # label, link-proxy-check.mjs args...: counts its ok/FAIL lines
  local label=$1 line; shift
  rm -rf "$TMP/work"; mkdir -p "$TMP/work"
  node "$HERE/link-proxy-check.mjs" "$PROXY" "$TMP/work" "$@" >"$TMP/check.out" 2>&1
  local rc=$?
  while IFS= read -r line; do
    case $line in
      "ok   - "*) ok "$label: ${line#ok   - }";;
      "FAIL - "*) ko "$label: ${line#FAIL - }";;
      *) echo "$line";;
    esac
  done <"$TMP/check.out"
  [ $rc = 0 ] || grep -q '^FAIL' "$TMP/check.out" || ko "$label: link-proxy-check.mjs exited $rc" "$(cat "$TMP/check.out")"
}
run_checks "in-process server"
if [ -n "${LINK_PROXY_SERVER_PORT:-}" ]; then
  curl -fs "http://localhost:$LINK_PROXY_SERVER_PORT/health" >/dev/null \
    || ko "lab server :$LINK_PROXY_SERVER_PORT is up (qa/lab/lab.sh server --port $LINK_PROXY_SERVER_PORT)"
  run_checks "lab server :$LINK_PROXY_SERVER_PORT" --server-port "$LINK_PROXY_SERVER_PORT"
fi

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
