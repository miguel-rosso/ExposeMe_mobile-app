#!/usr/bin/env bash
# `lab.sh play` argument parsing and Maestro env plumbing (EXP-212), with stub node/maestro and a fake devices.json:
# no devices, servers or network. Covers --second-room (2nd bots room -> NEW_CODE), --maestro-env KEY=VALUE and
# --server/--port (EXP-220: bots and render telemetry on a worktree's own lab server), and the kicked-notice
# invocation (EXP-139: --bot-args '--kick <device label>'), and the one retry of a device whose dev client got stuck
# downloading the JS bundle (EXP-256) or whose dev-client-boot.yaml loaded check failed: its bundle wait ran out
# (EXP-297) or it gave up at once on "There was a problem loading the project" (EXP-304); the scoreboards each device
# checked in play-rounds.yaml and the Maestro version warning (EXP-312).
# Run: qa/lab/tests/lab-play.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="$HERE/../../maestro"
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
echo '[{"id":"FAKE-1","label":"ios-a","platform":"ios"},{"id":"emulator-5554","label":"android-a","platform":"android"}]' >"$DEVICES_JSON"
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
# maestro stub: logs its argv; the runs whose --test-output-dir name is listed in STUB_MAESTRO_FAIL fail, leaving the
# screen hierarchy of their failed steps like Maestro does: an optional step showing STUB_EARLIER_SCREEN, then the
# last step (STUB_LAST_STEP, default 011) showing STUB_LAST_SCREEN (default: the dev client stuck on the bundle download).
# With STUB_FAILED_CONDITION it also writes Maestro's commands.json: an assertTrue that passed (STUB_PASSED_CONDITION,
# optional), then the failed one with that condition inside its failed parent runFlow. `--version` prints
# STUB_MAESTRO_VERSION (default 2.11.0). A passing run with STUB_SCOREBOARD_PASSES ("SKIPPED COMPLETED ...") writes
# the commands.json of play-rounds.yaml's round loop: one card-wait guard (STUB_SCOREBOARD_GUARD) per pass, and one
# held-check guard (STUB_HELD_GUARD) per entry of STUB_HELD_PASSES
cat >"$TMP/bin/maestro" <<'EOF'
#!/usr/bin/env bash
[ "$1" = --version ] && { echo "${STUB_MAESTRO_VERSION:-2.11.0}"; exit 0; }
echo "$*" >>"$STUB_LOG/maestro.args"
out=""; while [ $# -gt 0 ]; do [ "$1" = --test-output-dir ] && out=$2; shift; done
guards() { # CONDITION, statuses... -> one runFlow per status
  local condition=$1 status; shift
  for status in "$@"; do
    jq -n --arg c "$condition" --arg s "$status" '{command: {runFlowCommand: {condition: {scriptCondition: $c}}}, metadata: {status: $s}}'
  done
}
pass_commands() { # the round loop's guards
  # shellcheck disable=SC2086 # status lists
  { guards "$STUB_SCOREBOARD_GUARD" $STUB_SCOREBOARD_PASSES; guards "${STUB_HELD_GUARD:-}" ${STUB_HELD_PASSES:-}; } | jq -s .
}
case " ${STUB_MAESTRO_FAIL:-} " in *" ${out##*/} "*) ;; *)
  if [ -n "${STUB_SCOREBOARD_PASSES:-}" ]; then mkdir -p "$out/2026-10-29_164852/play-game"; pass_commands >"$out/2026-10-29_164852/play-game/commands.json"; fi
  exit 0;; esac
h="$out/2026-10-26_162536/play-game/screen-hierarchy"; mkdir -p "$h"
printf '{"attributes" : {"text" : "%s"}}\n' "${STUB_EARLIER_SCREEN:-Join Game}" >"$h/step-009-tapOnElement-optional.json"
printf '{"attributes" : {"text" : "%s"}}\n' "${STUB_LAST_SCREEN:-Downloading 55.0%…}" >"$h/step-${STUB_LAST_STEP:-011}-assertCondition.json"
[ -z "${STUB_FAILED_CONDITION:-}" ] && exit 1
assert() { jq -n --arg c "$1" --arg s "$2" '{command: {assertConditionCommand: {condition: {scriptCondition: $c}}}, metadata: {status: $s}}'; }
{ jq -n '{command: {runFlowCommand: {}}, metadata: {status: "FAILED"}}'
  [ -z "${STUB_PASSED_CONDITION:-}" ] || assert "$STUB_PASSED_CONDITION" COMPLETED
  assert "$STUB_FAILED_CONDITION" FAILED; } | jq -s . >"${h%/screen-hierarchy}/commands.json"
exit 1
EOF
chmod +x "$TMP/bin/node" "$TMP/bin/maestro"
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP"
MAESTRO="$TMP/bin/maestro"
kill() { echo "$*" >>"$TMP/kill.log"; builtin kill "$@"; }   # records which PIDs play signals
adbs() { echo "adb -s $*" >>"$TMP/device-cmds.log"; }        # record how a stuck app is stopped
xcrun() { echo "xcrun $*" >>"$TMP/device-cmds.log"; }

play() { # RUN_ID, args... -> runs cmd_play in a subshell under lab.sh's own shell options, returns its status
  rm -f "$TMP/node.args" "$TMP/maestro.args" "$TMP/linger.pid" "$TMP/main.pid" "$TMP/kill.log" "$TMP/device-cmds.log"
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

# ── kicked-notice (EXP-139): the host bot removes the device, named by its label (= its USERNAME) ──
play r-kick --bots 1 --devices ios-a --flow kicked-notice --bot-args "--kick ios-a"
rc=$?
[ $rc = 0 ] && completed r-kick && ok "kicked-notice play passes" || ko "kicked-notice play passes" "rc=$rc $(cat "$TMP/play.out")"
grep -q -- "--bots 1 --host --rounds 10 --wait-players 2 --kick ios-a" "$TMP/node.args" \
  && ok "the bots get --kick <device label>" || ko "the bots get --kick <device label>" "$(cat "$TMP/node.args")"
grep -q "maestro/kicked-notice.yaml" "$TMP/maestro.args" && grep -q -- "-e USERNAME=ios-a" "$TMP/maestro.args" \
  && ok "the device runs kicked-notice as ios-a" || ko "the device runs kicked-notice as ios-a" "$(cat "$TMP/maestro.args")"
grep -q -- "--flow kicked-notice --bots 1 --devices <label> --bot-args '--kick <label>'" "$HERE/../../maestro/kicked-notice.yaml" \
  && ok "kicked-notice.yaml documents that invocation" || ko "kicked-notice.yaml documents that invocation"

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
[ ! -e "$RUNS/r9/telemetry.jsonl" ] && ok "no rows of the game: no telemetry copy in the run dir" \
  || ko "no rows of the game: no telemetry copy" "$(cat "$RUNS/r9/telemetry.jsonl")"

# ── The game's telemetry rows are kept in the run dir (EXP-319): the next server start rotates the server's file ──
{ echo '{"gameCode":"ROOM2","username":"ios-a","phase":"answering","round":1,"at":1,"receivedAt":10}'
  echo '{"gameCode":"OTHER","username":"ios-a","phase":"answering","round":1,"at":1,"receivedAt":10}'
} >"$RUNS/telemetry-3103.jsonl"
play r9b --bots 2 --devices none --port 3103
rc=$?
[ $rc = 0 ] && completed r9b && [ "$(cat "$RUNS/r9b/telemetry.jsonl" 2>&1)" = "$(head -1 "$RUNS/telemetry-3103.jsonl")" ] \
  && ok "play saves the game's telemetry rows in the run dir" || ko "play saves the game's rows" "rc=$rc $(cat "$TMP/play.out")"
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

# ── Dev client stuck downloading the JS bundle (EXP-256): force-stop + one more run of the flow ──
runs_of() { grep -c -- "--test-output-dir $RUNS/$1/maestro/$2" "$TMP/maestro.args"; } # RUN_ID, run name prefix
STUB_MAESTRO_FAIL=android-a play r16 --bots 2 --devices ios-a,android-a
rc=$?
[ $rc = 0 ] && completed r16 && ok "stuck bundle download: the retry saves the run" || ko "stuck bundle download: retry saves the run" "rc=$rc $(cat "$TMP/play.out")"
grep -qF 'android-a: dev client stuck loading the JS bundle (stuck on its "Downloading N%"); force-stopping the app' "$TMP/play.out" \
  && ok "stuck bundle download: the retry is logged" || ko "stuck bundle download: retry logged" "$(cat "$TMP/play.out")"
[ "$(cat "$TMP/device-cmds.log" 2>/dev/null)" = "adb -s emulator-5554 shell am force-stop com.socketNull.ExposeMe" ] \
  && ok "stuck bundle download: only that app is force-stopped" || ko "stuck bundle download: force-stop" "$(cat "$TMP/device-cmds.log" 2>/dev/null)"
grep -q -- "--device emulator-5554 test .*play-game.yaml .*-e GAME_CODE=ROOM2 -e USERNAME=android-a .*--test-output-dir $RUNS/r16/maestro/android-a-retry --format junit --output $RUNS/r16/maestro/android-a-retry.xml" "$TMP/maestro.args" \
  && [ -d "$RUNS/r16/maestro/android-a" ] && ok "stuck bundle download: same flow and env re-run into <device>-retry, 1st attempt kept" \
  || ko "stuck bundle download: retry invocation" "$(cat "$TMP/maestro.args")"
[ "$(runs_of r16 ios-a)" = 1 ] && [ "$(runs_of r16 android-a)" = 2 ] \
  && ok "stuck bundle download: the other devices run once" || ko "stuck bundle download: other devices run once" "$(cat "$TMP/maestro.args")"
STUB_MAESTRO_FAIL=ios-a play r17 --bots 2 --devices ios-a
[ "$(cat "$TMP/device-cmds.log" 2>/dev/null)" = "xcrun simctl terminate FAKE-1 com.socketNull.ExposeMe" ] && [ "$(runs_of r17 ios-a)" = 2 ] \
  && ok "stuck bundle download on iOS: simctl terminate + retry" || ko "stuck bundle download on iOS" "$(cat "$TMP/device-cmds.log" 2>/dev/null)"
STUB_MAESTRO_FAIL="android-a android-a-retry" play r18 --bots 2 --devices android-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r18 android-a)" = 2 ] && grep -q "RUN r18 had failures" "$TMP/play.out" \
  && ok "stuck again on the retry: only one retry, the run fails" || ko "stuck again on the retry" "rc=$rc $(cat "$TMP/maestro.args")"
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="Join Game" play r19 --bots 2 --devices android-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r19 android-a)" = 1 ] && [ ! -s "$TMP/device-cmds.log" ] \
  && ok "other failures (app loaded): no retry, the run fails" || ko "other failures: no retry" "rc=$rc $(cat "$TMP/maestro.args")"
STUB_MAESTRO_FAIL=android-a STUB_EARLIER_SCREEN="Downloading 12.5%…" STUB_LAST_SCREEN="Join Game" play r20 --bots 2 --devices android-a
[ "$(runs_of r20 android-a)" = 1 ] && ok "a download seen only in an earlier step: no retry" || ko "earlier download step: no retry" "$(cat "$TMP/maestro.args")"
# Long flows pass step 999: the last step is chosen by number (as text, step-1000 sorts before step-009)
STUB_MAESTRO_FAIL=android-a STUB_EARLIER_SCREEN="Downloading 12.5%…" STUB_LAST_SCREEN="Join Game" STUB_LAST_STEP=1000 \
  play r21 --bots 2 --devices android-a
[ "$(runs_of r21 android-a)" = 1 ] && ok "last failed step chosen by number (step-1000 after step-009)" || ko "last failed step by number" "$(cat "$TMP/maestro.args")"
# A reused RUN_ID: an older run's hierarchies (a later step number, other timestamp folder) must not decide the retry
leftover() { # RUN_ID, screen text: an older run's last failed step left in maestro/android-a
  local h="$RUNS/$1/maestro/android-a/2026-10-25_000000/play-game/screen-hierarchy"; mkdir -p "$h"
  printf '{"attributes" : {"text" : "%s"}}\n' "$2" >"$h/step-1500-assertCondition.json"
}
leftover r22 "Join Game"
STUB_MAESTRO_FAIL=android-a play r22 --bots 2 --devices android-a
[ "$(runs_of r22 android-a)" = 2 ] && ok "reused RUN_ID: an older run's hierarchy doesn't hide this run's stuck download" || ko "reused RUN_ID: missed retry" "$(cat "$TMP/maestro.args")"
leftover r23 "Downloading 80.0%…"
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="Join Game" play r23 --bots 2 --devices android-a
[ "$(runs_of r23 android-a)" = 1 ] && ok "reused RUN_ID: an older run's stuck download doesn't trigger a retry" || ko "reused RUN_ID: false retry" "$(cat "$TMP/maestro.args")"

# ── dev-client-boot.yaml's bundle wait ran out (EXP-297): launcher, ANR dialog... -> the same one retry ──
grep -qxF -- "- assertTrue: $BOOT_LOADED_CONDITION" "$MAESTRO_DIR/dev-client-boot.yaml" \
  && ok "dev-client-boot.yaml still asserts lab.sh's BOOT_LOADED_CONDITION" || ko "dev-client-boot.yaml loaded check in sync with lab.sh"
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="Expose Me isn't responding" STUB_FAILED_CONDITION="$BOOT_LOADED_CONDITION" \
  play r25 --bots 2 --devices ios-a,android-a
rc=$?
[ $rc = 0 ] && completed r25 && [ "$(runs_of r25 android-a)" = 2 ] && [ "$(runs_of r25 ios-a)" = 1 ] \
  && [ "$(cat "$TMP/device-cmds.log" 2>/dev/null)" = "adb -s emulator-5554 shell am force-stop com.socketNull.ExposeMe" ] \
  && ok "boot wait ran out: force-stop + one retry saves the run" || ko "boot wait ran out: retry" "rc=$rc $(cat "$TMP/play.out" "$TMP/maestro.args")"
grep -qF "android-a: dev client stuck loading the JS bundle (dev-client-boot.yaml's bundle wait ran out); force-stopping" "$TMP/play.out" \
  && ok "boot wait ran out: the retry log names it" || ko "boot wait ran out: retry log" "$(cat "$TMP/play.out")"
STUB_MAESTRO_FAIL="android-a android-a-retry" STUB_LAST_SCREEN="DEVELOPMENT SERVERS" STUB_FAILED_CONDITION="$BOOT_LOADED_CONDITION" \
  play r26 --bots 2 --devices android-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r26 android-a)" = 2 ] && ok "boot wait ran out again on the retry: only one retry, the run fails" \
  || ko "boot wait ran out twice" "rc=$rc $(cat "$TMP/maestro.args")"
# shellcheck disable=SC2016 # a Maestro expression
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="Join Game" STUB_PASSED_CONDITION="$BOOT_LOADED_CONDITION" \
  STUB_FAILED_CONDITION='${output.round > 1}' play r27 --bots 2 --devices android-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r27 android-a)" = 1 ] && [ ! -s "$TMP/device-cmds.log" ] \
  && ok "another assertTrue failed after the app loaded: no retry" || ko "other assertTrue: no retry" "rc=$rc $(cat "$TMP/maestro.args")"

# ── "There was a problem loading the project" (EXP-304): dev-client-boot.yaml leaves its bundle wait at once on that (EXP-298)
# screen and fails the same loaded check, with no command after it -> the same one retry, logged with that reason ──
LOAD_ERROR_SCREEN="There was a problem loading the project.\nUnable to load script."
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="$LOAD_ERROR_SCREEN" STUB_FAILED_CONDITION="$BOOT_LOADED_CONDITION" \
  play r28 --bots 2 --devices ios-a,android-a
rc=$?
[ $rc = 0 ] && completed r28 && [ "$(runs_of r28 android-a)" = 2 ] && [ "$(runs_of r28 ios-a)" = 1 ] \
  && [ "$(cat "$TMP/device-cmds.log" 2>/dev/null)" = "adb -s emulator-5554 shell am force-stop com.socketNull.ExposeMe" ] \
  && ok "load error screen: force-stop + one retry saves the run" || ko "load error screen: retry" "rc=$rc $(cat "$TMP/play.out" "$TMP/maestro.args")"
grep -qF 'android-a: dev client stuck loading the JS bundle (showed "There was a problem loading the project"); force-stopping' "$TMP/play.out" \
  && ok "load error screen: the retry log names it" || ko "load error screen: retry log" "$(cat "$TMP/play.out")"
STUB_MAESTRO_FAIL="ios-a ios-a-retry" STUB_LAST_SCREEN="$LOAD_ERROR_SCREEN" STUB_FAILED_CONDITION="$BOOT_LOADED_CONDITION" \
  play r29 --bots 2 --devices ios-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r29 ios-a)" = 2 ] && grep -q "RUN r29 had failures" "$TMP/play.out" \
  && ok "load error screen again on the retry: only one retry, the run fails" || ko "load error twice" "rc=$rc $(cat "$TMP/maestro.args")"
# The decision stays dev-client-boot.yaml's loaded check: the error screen after the app loaded (e.g. a later reload)
# shellcheck disable=SC2016 # a Maestro expression
STUB_MAESTRO_FAIL=android-a STUB_LAST_SCREEN="$LOAD_ERROR_SCREEN" STUB_PASSED_CONDITION="$BOOT_LOADED_CONDITION" \
  STUB_FAILED_CONDITION='${output.round > 1}' play r30 --bots 2 --devices android-a
rc=$?
[ $rc != 0 ] && [ "$(runs_of r30 android-a)" = 1 ] && [ ! -s "$TMP/device-cmds.log" ] \
  && ok "load error screen after the boot check passed: no retry" || ko "load error after boot: no retry" "rc=$rc $(cat "$TMP/maestro.args")"

# ── Lobby wait covers one retry (EXP-256): the devices that joined keep waiting for the retried one ──
play r24 --bots 2 --devices ios-a
grep -q -- "-e LOBBY_WAIT_MS=$LOBBY_WAIT_MS " "$TMP/maestro.args" && ok "play passes LOBBY_WAIT_MS to the flows" || ko "LOBBY_WAIT_MS passed" "$(cat "$TMP/maestro.args")"
grep -qF "timeout: \${LOBBY_WAIT_MS || $LOBBY_WAIT_MS}" "$MAESTRO_DIR/wait-game-start.yaml" \
  && ok "wait-game-start.yaml defaults to lab.sh's LOBBY_WAIT_MS ($LOBBY_WAIT_MS ms)" || ko "wait-game-start.yaml default in sync with lab.sh"
# open-app.yaml's bundle wait lives in its dev-client-boot.yaml subflow: the longest wait there
first_open_wait_ms="$(grep -oE 'timeout: [0-9]+' "$MAESTRO_DIR/dev-client-boot.yaml" | grep -oE '[0-9]+$' | sort -n | tail -1)"
[ "$((STUCK_ATTEMPT_S * 1000))" -gt "$first_open_wait_ms" ] \
  && [ "$LOBBY_WAIT_MS" -ge "$(((STUCK_ATTEMPT_S + RETRY_OPEN_JOIN_S) * 1000))" ] && [ "$LOBBY_WAIT_MS" -ge 420000 ] \
  && ok "lobby budget: stuck attempt > open-app's bundle wait ($first_open_wait_ms ms), lobby >= stuck attempt + retry" \
  || ko "lobby budget" "stuck=$STUCK_ATTEMPT_S open=$first_open_wait_ms lobby=$LOBBY_WAIT_MS"
for f in play-rounds many-players no-result-game waiting-photo tie-game hold-used-up; do
  grep -q -- "- runFlow: wait-game-start.yaml" "$MAESTRO_DIR/$f.yaml" && ok "$f.yaml waits in the lobby with the budget" || ko "$f.yaml uses wait-game-start.yaml"
done

# ── play-rounds.yaml's checked scoreboards and the Maestro it was verified on (EXP-312) ──
sed 's/^[[:space:]]*//' "$MAESTRO_DIR/play-rounds.yaml" | grep -qxF "true: $SCOREBOARD_GUARD" \
  && ok "play-rounds.yaml's card wait has lab.sh's SCOREBOARD_GUARD" || ko "play-rounds.yaml card-wait guard in sync with lab.sh"
sed 's/^[[:space:]]*//' "$MAESTRO_DIR/play-rounds.yaml" | grep -qxF "true: $HELD_GUARD" \
  && ok "play-rounds.yaml's held check has lab.sh's HELD_GUARD" || ko "play-rounds.yaml held-check guard in sync with lab.sh"
export STUB_SCOREBOARD_GUARD="$SCOREBOARD_GUARD" STUB_SCOREBOARD_PASSES="SKIPPED COMPLETED SKIPPED COMPLETED COMPLETED"
export STUB_HELD_GUARD="$HELD_GUARD" STUB_HELD_PASSES="SKIPPED SKIPPED SKIPPED SKIPPED SKIPPED"
play r30 --bots 2 --devices android-a
rc=$?
[ $rc = 0 ] && grep -q "android-a: 3/4 scoreboards checked, 0 held (play-rounds.yaml)" "$TMP/play.out" \
  && ok "play prints each device's checked scoreboards (the loop's first pass has none)" \
  || ko "play prints checked scoreboards" "rc=$rc $(cat "$TMP/play.out")"
# EXP-325: a pass whose card wait found the scoreboard held completes its guard too: it counts as held, not checked
STUB_HELD_PASSES="SKIPPED SKIPPED SKIPPED COMPLETED SKIPPED" play r34 --bots 2 --devices android-a
rc=$?
[ $rc = 0 ] && grep -q "android-a: 2/4 scoreboards checked, 1 held (play-rounds.yaml)" "$TMP/play.out" \
  && ok "play prints each device's held scoreboards apart from the checked ones" \
  || ko "play prints held scoreboards" "rc=$rc $(cat "$TMP/play.out")"
unset STUB_SCOREBOARD_PASSES STUB_HELD_PASSES
play r31 --bots 2 --devices android-a
! grep -q "scoreboards checked" "$TMP/play.out" && ok "a flow without the round loop prints no scoreboard count" \
  || ko "no scoreboard count without play-rounds.yaml" "$(cat "$TMP/play.out")"
! grep -q "is not 2.11.x" "$TMP/play.out" && ok "Maestro 2.11.0: no version warning" || ko "Maestro 2.11.0: no version warning" "$(cat "$TMP/play.out")"
STUB_MAESTRO_VERSION=2.12.1 play r32 --bots 2 --devices android-a
rc=$?
[ $rc = 0 ] && grep -q "Maestro 2.12.1 is not 2.11.x" "$TMP/play.out" \
  && ok "another Maestro version: play warns and goes on" || ko "Maestro version warning" "rc=$rc $(cat "$TMP/play.out")"
STUB_MAESTRO_VERSION=2.12.1 play r33 --bots 2 --devices none
! grep -q "is not 2.11.x" "$TMP/play.out" && ok "no devices: no Maestro version check" || ko "no devices: no version check" "$(cat "$TMP/play.out")"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
