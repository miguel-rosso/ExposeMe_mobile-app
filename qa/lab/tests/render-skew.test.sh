#!/usr/bin/env bash
# QA render telemetry in the lab (EXP-012): qa/lab/render-skew.mjs turns the server's qa-ack lines into per-phase device
# render skew, `play` prints it, and the lab server/Metro run with the telemetry flags. No devices, servers or network.
# Run: qa/lab/tests/render-skew.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKEW="$HERE/../render-skew.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }
jget() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],JSON.parse(require("fs").readFileSync(0,"utf8")));console.log(JSON.stringify(v))' _ "$1"; }

# ── render-skew.mjs ──
ack() { # game, user, phase, round, receivedAt
  printf '{"gameCode":"%s","username":"%s","phase":"%s","round":%s,"at":1,"receivedAt":%s}\n' "$@"
}
{
  # round 1: answering spread 40, reveal spread 10, scores 0
  ack ROOM1 ios-a answering 1 1000; ack ROOM1 android-a answering 1 1040
  ack ROOM1 ios-a reveal 1 2000;    ack ROOM1 android-a reveal 1 2010
  ack ROOM1 ios-a scores 1 3000;    ack ROOM1 android-a scores 1 3000
  # round 2: answering spread 100; ios-a re-acks answering after a resume, and that line comes first in the file
  # (only its earliest ack counts)
  ack ROOM1 ios-a answering 2 9000; ack ROOM1 ios-a answering 2 5000; ack ROOM1 android-a answering 2 5100
  # a phase only one device rendered has no skew
  ack ROOM1 ios-a waiting-photo 3 7000
  # other games and junk lines are ignored
  ack OTHER ios-a answering 1 0; ack OTHER x answering 1 99999
  echo 'not json'; echo; echo '{"gameCode":"ROOM1","username":"z","phase":"answering","round":1}'
} >"$TMP/telemetry.jsonl"

out="$(node "$SKEW" "$TMP/telemetry.jsonl" ROOM1)"; rc=$?
[ $rc = 0 ] && ok "summary exits 0" || ko "summary exits 0" "rc=$rc"
[ "$(jget gameCode <<<"$out")" = '"ROOM1"' ] && ok "summary names the room" || ko "summary names the room" "$out"
[ "$(jget devices <<<"$out")" = '["android-a","ios-a"]' ] && ok "devices of that room only" || ko "devices of that room only" "$out"
[ "$(jget phases.answering <<<"$out")" = '{"instances":2,"p50":40,"p95":100,"max":100}' ] \
  && ok "answering: p50/p95/max of earliest-ack spreads" || ko "answering: p50/p95/max of earliest-ack spreads" "$out"
[ "$(jget phases.reveal <<<"$out")" = '{"instances":1,"p50":10,"p95":10,"max":10}' ] \
  && ok "reveal skew" || ko "reveal skew" "$out"
[ "$(jget phases.scores.max <<<"$out")" = 0 ] && ok "simultaneous render is 0 ms skew" || ko "simultaneous render is 0 ms skew" "$out"
[ "$(jget phases.waiting-photo <<<"$out")" = undefined ] && ok "a phase seen by one device has no skew" || ko "a phase seen by one device has no skew" "$out"
[ "$(node "$SKEW" "$TMP/telemetry.jsonl" NOPE | jget phases)" = '{}' ] && ok "unknown room: empty phases" || ko "unknown room: empty phases"
[ "$(jget latency <<<"$out")" = '{}' ] && ok "acks without handledAt: no device latency" || ko "acks without handledAt: no device latency" "$out"

# ── render-skew.mjs: per-device latency (EXP-223) ──
lack() { # game, user, phase, round, serverAt (- = none), handledAt, at, receivedAt
  local server=""; [ "$5" = - ] || server=",\"serverAt\":$5"
  printf '{"gameCode":"%s","username":"%s","phase":"%s","round":%s%s,"handledAt":%s,"at":%s,"receivedAt":%s}\n' \
    "$1" "$2" "$3" "$4" "$server" "$6" "$7" "$8"
}
{
  # ios-a, clock in sync with the server: delivery 10 / 50, handler→paint 20 / 10 (round 1 has the shortest round trip)
  lack LAT ios-a answering 1 1000 1010 1030 1040
  lack LAT ios-a answering 2 5000 5050 5060 5080
  # a serverAt that can't be the broadcast this ack answers (negative round trip): never the clock-offset sample
  lack LAT ios-a scores 1 9000 8900 8910 8920
  # android-a, clock 3000 ms behind the server: delivery 20 / 200 (server clock), handler→paint 300 / 500
  lack LAT android-a answering 1 1000 -1980 -1680 1340
  lack LAT android-a answering 2 5000 2200 2700 5730
  # an ack without serverAt (the room had moved on): handler→paint only
  lack LAT android-a reveal 1 - 5000 5100 8200
  # a resumed phase (no handledAt) doesn't count
  ack LAT android-a scores 1 9000
  # a device that never had a serverAt: no clock offset, no delivery
  lack LAT bot-x reveal 1 - 100 160 4000
} >"$TMP/latency.jsonl"
out="$(node "$SKEW" "$TMP/latency.jsonl" LAT)"
[ "$(jget latency.ios-a.clockOffset <<<"$out")" = 0 ] && ok "clock offset of a device in sync" || ko "clock offset of a device in sync" "$out"
[ "$(jget latency.android-a.clockOffset <<<"$out")" = -3000 ] \
  && ok "clock offset from the shortest round trip" || ko "clock offset from the shortest round trip" "$out"
[ "$(jget latency.ios-a.phases.answering <<<"$out")" = '{"delivery":{"n":2,"p50":10,"p95":50},"handlerToPaint":{"n":2,"p50":10,"p95":20}}' ] \
  && ok "ios delivery and handler→paint p50/p95" || ko "ios delivery and handler→paint p50/p95" "$out"
[ "$(jget latency.android-a.phases.answering <<<"$out")" = '{"delivery":{"n":2,"p50":20,"p95":200},"handlerToPaint":{"n":2,"p50":300,"p95":500}}' ] \
  && ok "android delivery corrected by its clock offset" || ko "android delivery corrected by its clock offset" "$out"
[ "$(jget latency.android-a.phases.reveal <<<"$out")" = '{"handlerToPaint":{"n":1,"p50":100,"p95":100}}' ] \
  && ok "no serverAt: handler→paint only" || ko "no serverAt: handler→paint only" "$out"
[ "$(jget latency.android-a.phases.scores <<<"$out")" = undefined ] \
  && ok "resumed phase (no handledAt) ignored" || ko "resumed phase (no handledAt) ignored" "$out"
[ "$(jget latency.bot-x <<<"$out")" = '{"clockOffset":null,"phases":{"reveal":{"handlerToPaint":{"n":1,"p50":60,"p95":60}}}}' ] \
  && ok "no serverAt at all: no clock offset" || ko "no serverAt at all: no clock offset" "$out"

node "$SKEW" "$TMP/telemetry.jsonl" >/dev/null 2>&1; rc=$?
[ $rc = 2 ] && ok "missing room code: usage error" || ko "missing room code: usage error" "rc=$rc"

# ── lab.sh helpers ──
# shellcheck source=../lab.sh
source "$HERE/../lab.sh"
set +e
RUNS="$TMP/runs"; STATE="$TMP/state"; mkdir -p "$RUNS/run1" "$STATE"

[ "$(telemetry_file)" = "$RUNS/telemetry.jsonl" ] && ok "shared server telemetry file" || ko "shared server telemetry file"
[ "$(telemetry_file 3000)" = "$RUNS/telemetry.jsonl" ] && ok "port 3000 is the shared file" || ko "port 3000 is the shared file"
[ "$(telemetry_file 3101)" = "$RUNS/telemetry-3101.jsonl" ] && ok "worktree server has its own file" || ko "worktree server has its own file"

out="$(print_render_skew "$RUNS/run1" ROOM1 2>&1)"
[ -z "$out" ] && [ ! -e "$RUNS/run1/render-skew.json" ] \
  && ok "no telemetry (no QA build played): nothing printed" || ko "no telemetry: nothing printed" "$out"

cp "$TMP/telemetry.jsonl" "$RUNS/telemetry.jsonl"
out="$(print_render_skew "$RUNS/run1" ROOM1 2>&1)"
grep -q "device render skew" <<<"$out" && grep -q '"answering"' <<<"$out" \
  && ok "play prints the render skew" || ko "play prints the render skew" "$out"
[ "$(jget phases.answering.max <"$RUNS/run1/render-skew.json")" = 100 ] \
  && ok "render skew saved in the run dir" || ko "render skew saved in the run dir"

# A reused RUN_ID whose new game had no QA build (server restarted: empty telemetry) drops the previous game's skew
: >"$RUNS/telemetry.jsonl"
out="$(print_render_skew "$RUNS/run1" ROOM1 2>&1)"
[ -z "$out" ] && [ ! -e "$RUNS/run1/render-skew.json" ] \
  && ok "no telemetry on a reused run dir: the previous game's render-skew.json is removed" \
  || ko "stale render-skew.json removed" "$out $(cat "$RUNS/run1/render-skew.json" 2>&1 | head -3)"

# ── save_game_telemetry (EXP-319): the game's raw rows outlive the server's next rotation ──
rm -f "$RUNS/telemetry.jsonl"
out="$(save_game_telemetry "$RUNS/run1" ROOM1 2>&1)"; rc=$?
[ $rc = 0 ] && [ -z "$out" ] && [ ! -e "$RUNS/run1/telemetry.jsonl" ] \
  && ok "no telemetry file: nothing saved, no error" || ko "no telemetry file: nothing saved" "rc=$rc $out"

cp "$TMP/telemetry.jsonl" "$RUNS/telemetry.jsonl"
out="$(save_game_telemetry "$RUNS/run1" ROOM1 2>&1)"; rc=$?
expected="$(grep '"gameCode":"ROOM1"' "$TMP/telemetry.jsonl")"   # verbatim, in file order (incl. the row without receivedAt)
[ $rc = 0 ] && [ "$(cat "$RUNS/run1/telemetry.jsonl")" = "$expected" ] \
  && ok "only that game's rows saved verbatim in the run dir" || ko "game rows saved" "rc=$rc $(cat "$RUNS/run1/telemetry.jsonl" 2>&1)"
grep -q "$RUNS/run1/telemetry.jsonl" <<<"$out" && grep -q "$(grep -c . <<<"$expected") rows" <<<"$out" \
  && ok "play logs where the rows went" || ko "play logs where the rows went" "$out"
[ "$(node "$SKEW" "$RUNS/run1/telemetry.jsonl" ROOM1)" = "$(node "$SKEW" "$TMP/telemetry.jsonl" ROOM1)" ] \
  && ok "the saved rows reproduce the render skew later" || ko "saved rows reproduce the render skew"

out="$(save_game_telemetry "$RUNS/run1" NOPE 2>&1)"; rc=$?
[ $rc = 0 ] && [ -z "$out" ] && [ ! -e "$RUNS/run1/telemetry.jsonl" ] \
  && ok "no rows of that game (reused RUN_ID): stale copy removed, nothing saved" || ko "no rows of that game" "rc=$rc $out"

mkdir -p "$RUNS/run2"; cp "$TMP/latency.jsonl" "$RUNS/telemetry-3101.jsonl"
save_game_telemetry "$RUNS/run2" LAT 3101 >/dev/null 2>&1
[ "$(wc -l <"$RUNS/run2/telemetry.jsonl" | tr -d ' ')" = 8 ] \
  && ok "worktree server: rows from its own telemetry file" || ko "worktree server telemetry" "$(cat "$RUNS/run2/telemetry.jsonl" 2>&1)"

# Flags: the lab server records telemetry, Metro builds QA clients (bg_start/curl stubbed: nothing is started)
bg_start() { echo "$*" >"$TMP/bg_start.args"; }
curl() { echo "packager-status:running"; }
port_listeners() { :; }   # the real :8081/:3101 (a running lab Metro) must not trip the port-in-use guard
bg_pid_is() { kill -0 "$1" 2>/dev/null; }   # stand-in pids (this shell) are not real lab processes
cmd_server --port 3101 >/dev/null 2>&1
grep -q "QA_TELEMETRY=1 QA_TELEMETRY_FILE=$RUNS/telemetry-3101.jsonl" "$TMP/bg_start.args" \
  && ok "server runs with QA_TELEMETRY and its file" || ko "server runs with QA_TELEMETRY and its file" "$(cat "$TMP/bg_start.args")"
client_path() { echo "$PATH"; }
cmd_metro >/dev/null 2>&1
grep -q "EXPO_PUBLIC_QA=1" "$TMP/bg_start.args" && ok "Metro runs with EXPO_PUBLIC_QA=1" || ko "Metro runs with EXPO_PUBLIC_QA=1"

# Rotation: a server start keeps only the previous session's telemetry; a server already running keeps its file
echo old >"$RUNS/telemetry-3101.jsonl"; echo older >"$RUNS/telemetry-3101.jsonl.prev"
cmd_server --port 3101 >/dev/null 2>&1
[ ! -e "$RUNS/telemetry-3101.jsonl" ] && [ "$(cat "$RUNS/telemetry-3101.jsonl.prev")" = old ] \
  && ok "server start rotates its telemetry file" || ko "server start rotates its telemetry file"
echo live >"$RUNS/telemetry-3101.jsonl"; echo $$ >"$STATE/server-3101.pid"   # this shell stands in for a running server
cmd_server --port 3101 >/dev/null 2>&1
[ "$(cat "$RUNS/telemetry-3101.jsonl")" = live ] \
  && ok "already running: telemetry kept" || ko "already running: telemetry kept"
rm -f "$STATE/server-3101.pid"

echo "$pass passed, $fail failed"
[ $fail = 0 ]
