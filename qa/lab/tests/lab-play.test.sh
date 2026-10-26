#!/usr/bin/env bash
# `lab.sh play` argument parsing and Maestro env plumbing (EXP-212), with stub node/maestro and a fake devices.json:
# no devices, servers or network. Covers --second-room (2nd bots room -> NEW_CODE), --maestro-env KEY=VALUE and
# --server/--port (EXP-220: bots and render telemetry on a worktree's own lab server).
# Run: qa/lab/tests/lab-play.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# shellcheck source=../lab.sh
source "$HERE/../lab.sh"
set +e

# ── Fake environment ──
RUNS="$TMP/runs"; DEVICES_JSON="$TMP/devices.json"; QA="$TMP/qa"
mkdir -p "$TMP/bin" "$QA/lab"
echo '[{"id":"FAKE-1","label":"ios-a","platform":"ios"}]' >"$DEVICES_JSON"
# node stub: `node bots.mjs ...` logs its argv, writes a room code (ROOM<--bots>) to --code-file and an empty
# summary to --out; a room started with --wait-players 99 (the "second room") then lingers like a lobby-only room.
cat >"$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -e ] && { echo "SUMMARY $(cat "$3")"; exit 0; }   # the summary print at the end of play
[[ "$1" == *render-skew.mjs ]] && { echo "SKEW $2 $3"; exit 0; }   # print_render_skew: telemetry file, room code
echo "$*" >>"$STUB_LOG/node.args"
bots="" code_file="" out="" linger=0
while [ $# -gt 0 ]; do case $1 in
  --bots) bots=$2; shift;; --code-file) code_file=$2; shift;; --out) out=$2; shift;;
  --wait-players) [ "$2" = 99 ] && linger=1; shift;; esac; shift; done
[ "${STUB_NO_CODE:-}" = "$bots" ] || echo "ROOM$bots" >"$code_file"
echo '{"summary":{"pass":true}}' >"$out"
if [ $linger = 1 ]; then echo $$ >"$STUB_LOG/linger.pid"; exec sleep 30; fi
echo $$ >"$STUB_LOG/main.pid"
EOF
printf '#!/usr/bin/env bash\necho "$*" >>"$STUB_LOG/maestro.args"\n' >"$TMP/bin/maestro"
chmod +x "$TMP/bin/node" "$TMP/bin/maestro"
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP"
MAESTRO="$TMP/bin/maestro"
kill() { echo "$*" >>"$TMP/kill.log"; builtin kill "$@"; }   # records which PIDs play signals

play() { # RUN_ID, args... -> runs cmd_play in a subshell under lab.sh's own shell options, returns its status
  rm -f "$TMP/node.args" "$TMP/maestro.args" "$TMP/linger.pid" "$TMP/main.pid" "$TMP/kill.log"
  ( set -euo pipefail; RUN_ID=$1; shift; cmd_play "$@" ) >"$TMP/play.out" 2>&1
}
completed() { # RUN_ID: play got to the end, printing the bots summary and its PASS line
  grep -q '^SUMMARY .*"pass":true' "$TMP/play.out" && grep -q "RUN $1 PASS" "$TMP/play.out"
}

# ── Baseline: no second room ──
play r1 --bots 2 --rounds 3 --devices ios-a
rc=$?
[ $rc = 0 ] && completed r1 && ok "plain play passes (summary + PASS line)" || ko "plain play passes" "rc=$rc $(cat "$TMP/play.out")"
[ "$(wc -l <"$TMP/node.args" | tr -d ' ')" = 1 ] && ok "plain play starts one bots room" || ko "plain play starts one bots room"
grep -q -- "-e GAME_CODE=ROOM2" "$TMP/maestro.args" && ok "GAME_CODE passed to maestro" || ko "GAME_CODE passed to maestro"
grep -q "NEW_CODE" "$TMP/maestro.args" && ko "no NEW_CODE without --second-room" || ok "no NEW_CODE without --second-room"

# ── --second-room ──
play r2 --bots 2 --rounds 3 --devices ios-a --flow invite-link-after-game \
  --second-room "--bots 3 --host --wait-players 99 --timeout 900"
rc=$?
[ $rc = 0 ] && completed r2 && ok "play with --second-room passes (lingering room is not a failure)" || ko "play with --second-room passes" "rc=$rc $(cat "$TMP/play.out")"
grep -q -- "--bots 3 --host --wait-players 99 --timeout 900" "$TMP/node.args" && ok "second room gets its bots.mjs args" || ko "second room gets its bots.mjs args"
grep -q -- "--code-file $RUNS/r2/second-room/code" "$TMP/node.args" && ok "second room writes its own code file" || ko "second room writes its own code file"
grep -q -- "--out $RUNS/r2/second-room/bots.json" "$TMP/node.args" && ok "second room writes its own summary" || ko "second room writes its own summary"
grep -q -- "--code-file $RUNS/r2/code " "$TMP/node.args" && ok "main room keeps its code file" || ko "main room keeps its code file"
grep -q -- "-e GAME_CODE=ROOM2" "$TMP/maestro.args" && grep -q -- "-e NEW_CODE=ROOM3" "$TMP/maestro.args" \
  && ok "maestro gets GAME_CODE (main) and NEW_CODE (second room)" || ko "maestro gets GAME_CODE and NEW_CODE" "$(cat "$TMP/maestro.args")"
grep -q "invite-link-after-game.yaml" "$TMP/maestro.args" && ok "--flow still selects the flow" || ko "--flow still selects the flow"
pid="$(cat "$TMP/linger.pid" 2>/dev/null)"
[ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && ok "second bots room is stopped at the end" || ko "second bots room is stopped at the end" "pid=$pid"
main_pid="$(cat "$TMP/main.pid" 2>/dev/null)"
[ -n "$main_pid" ] && ! grep -qw "$main_pid" "$TMP/kill.log" \
  && ok "main bots PID is not signalled after it was reaped (PID reuse)" || ko "main bots PID not signalled after wait" "main=$main_pid kills=$(cat "$TMP/kill.log" 2>/dev/null)"

# Second room never publishes a code: fail loudly, nothing left running, no device run
STUB_NO_CODE=3 LAB_ROOM_CODE_TIMEOUT=1 play r3 --bots 2 --devices ios-a --second-room "--bots 3 --host --wait-players 99"
rc=$?
pid="$(cat "$TMP/linger.pid" 2>/dev/null)"
[ $rc != 0 ] && grep -q "second room" "$TMP/play.out" && ok "second room without code -> non-zero + clear message" || ko "second room without code -> fails loudly" "rc=$rc"
[ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && ok "second room killed when it fails" || ko "second room killed when it fails" "pid=$pid"
[ ! -s "$TMP/maestro.args" ] && ok "no device run when a room fails" || ko "no device run when a room fails"

# Main room never publishes a code: the already-started second room is cleaned up too
STUB_NO_CODE=2 LAB_ROOM_CODE_TIMEOUT=1 play r4 --bots 2 --devices ios-a --second-room "--bots 3 --host --wait-players 99"
rc=$?
pid="$(cat "$TMP/linger.pid" 2>/dev/null)"
[ $rc != 0 ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && ok "main room failure also stops the second room" || ko "main room failure also stops the second room" "rc=$rc pid=$pid"

# ── --maestro-env ──
play r5 --bots 2 --devices ios-a --maestro-env FOO=bar --maestro-env "MSG=a b=c"
rc=$?
[ $rc = 0 ] && completed r5 && grep -q -- "-e FOO=bar" "$TMP/maestro.args" && grep -q -- "-e MSG=a b=c" "$TMP/maestro.args" \
  && ok "--maestro-env is repeatable and keeps '=' and spaces in the value" || ko "--maestro-env forwarded" "rc=$rc $(cat "$TMP/maestro.args" 2>/dev/null)"
for bad in "noequals" "=value" "1KEY=v" "BAD-KEY=v"; do
  play r6 --bots 2 --devices ios-a --maestro-env "$bad"; rc=$?
  [ $rc != 0 ] && [ ! -s "$TMP/node.args" ] && ok "--maestro-env '$bad' rejected before starting bots" || ko "--maestro-env '$bad' rejected" "rc=$rc"
done
play r7 --bots 2 --devices ios-a --second-room; rc=$?
[ $rc != 0 ] && ok "--second-room without a value is rejected" || ko "--second-room without a value is rejected"

# ── --server / --port: bots and telemetry on another lab server (EXP-220) ──
play r8 --bots 2 --devices ios-a
grep -q -- "--server http://localhost:3000 " "$TMP/node.args" && ok "default: bots use the shared lab server" || ko "default: bots use :3000" "$(cat "$TMP/node.args")"
grep -q "can't join" "$TMP/play.out" && ko "default: no devices warning" || ok "default: no devices warning"
mkdir -p "$RUNS"; echo '{"shared":1}' >"$RUNS/telemetry.jsonl"; echo '{"own":1}' >"$RUNS/telemetry-3103.jsonl"
play r9 --bots 2 --devices none --port 3103
rc=$?
[ $rc = 0 ] && completed r9 && grep -q -- "--server http://localhost:3103 " "$TMP/node.args" \
  && ok "--port P: bots play on localhost:P" || ko "--port P: bots on localhost:P" "rc=$rc $(cat "$TMP/node.args" "$TMP/play.out")"
grep -q "^SKEW $RUNS/telemetry-3103.jsonl ROOM2$" "$TMP/play.out" && ok "--port P: render skew read from that server's telemetry" \
  || ko "--port P: telemetry of that server" "$(cat "$TMP/play.out")"
grep -q "can't join" "$TMP/play.out" && ko "--devices none: no devices warning" || ok "--devices none: no devices warning"
play r10 --bots 2 --devices ios-a --server http://localhost:3103/ --second-room "--bots 3 --host --wait-players 99"
rc=$?
[ $rc = 0 ] && [ "$(grep -c -- "--server http://localhost:3103 " "$TMP/node.args")" = 2 ] \
  && ok "--server URL: main and second room on that server" || ko "--server URL: both rooms" "rc=$rc $(cat "$TMP/node.args")"
grep -q "^SKEW $RUNS/telemetry-3103.jsonl" "$TMP/play.out" && ok "--server URL: render skew from that server's telemetry" || ko "--server URL: telemetry" "$(cat "$TMP/play.out")"
grep -q "shared server :3000, so they can't join a room on :3103" "$TMP/play.out" \
  && ok "--server with devices: warns that devices/Metro stay on :3000" || ko "--server with devices: warning" "$(cat "$TMP/play.out")"
play r11 --bots 2 --devices none --server http://127.0.0.1:3104
grep -q -- "--server http://localhost:3104 " "$TMP/node.args" && ok "--server http://127.0.0.1:P accepted" || ko "--server 127.0.0.1 accepted" "$(cat "$TMP/play.out")"
for bad in "--server https://exposeme.onrender.com" "--server http://localhost" "--server http://10.0.0.2:3000" "--port abc" "--port 0" "--port 70000" "--server http://localhost:65536" "--port"; do
  # shellcheck disable=SC2086 # bad is an option and its value
  play r12 --bots 2 --devices none $bad; rc=$?
  [ $rc != 0 ] && [ ! -s "$TMP/node.args" ] && grep -q "local lab server" "$TMP/play.out" \
    && ok "'$bad' rejected before starting bots" || ko "'$bad' rejected" "rc=$rc $(cat "$TMP/play.out")"
done
play r13 --bots 2 --devices none --port 65535
grep -q -- "--server http://localhost:65535 " "$TMP/node.args" && ok "--port 65535 accepted" || ko "--port 65535 accepted" "$(cat "$TMP/play.out")"
# The bots.mjs flags of --bot-args / --second-room must not pick another server (bots.mjs keeps the last --server)
for opt in --bot-args --second-room; do
  for flags in "--no-answer --server https://exposeme.onrender.com" "--server=https://exposeme.onrender.com" "SERVER_URL=https://exposeme.onrender.com"; do
    play r14 --bots 2 --devices none "$opt" "$flags"; rc=$?
    [ $rc != 0 ] && [ ! -s "$TMP/node.args" ] && grep -q "use play's own --server" "$TMP/play.out" \
      && ok "$opt '$flags' rejected before starting bots" || ko "$opt '$flags' rejected" "rc=$rc $(cat "$TMP/play.out" "$TMP/node.args" 2>/dev/null)"
  done
done
play r15 --bots 2 --devices none --bot-args "--no-answer --play-again-linger-bot 0 --play-again-linger 1"
[ $? = 0 ] && ok "--bot-args without a server still accepted" || ko "--bot-args without a server accepted" "$(cat "$TMP/play.out")"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
