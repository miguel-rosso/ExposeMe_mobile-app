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

out="$(node "$SKEW" "$TMP/telemetry.jsonl" ROOM1 2>/dev/null)"; rc=$?
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
out="$(node "$SKEW" "$TMP/latency.jsonl" LAT 2>/dev/null)"
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

# ── render-skew.mjs: round photo on screen per platform (EXP-395) ──
phase_ack() { # game, user, platform, phase, round, at, [resume]: the device's qa-ack at its device time `at` (painted by
  # its phase's event it carries handledAt; a resumed or rejoined paint doesn't)
  local handled=",\"handledAt\":$(($6 - 10))"; [ "${7:-}" = resume ] && handled=""
  printf '{"gameCode":"%s","username":"%s","phase":"%s","platform":"%s","round":%s,"at":%s,"receivedAt":%s%s}\n' \
    "$1" "$2" "$4" "$3" "$5" "$6" "$6" "$handled"
}
paint() { phase_ack "$1" "$2" "$3" answering "${@:4}"; } # game, user, platform, round, at, [resume]: its answering paint
shown() { # game, user, platform, round, at, [failed]: its qa-photo-shown line
  local failed=""; [ "${6:-}" = failed ] && failed=',"failed":true'
  printf '{"kind":"photo-shown","gameCode":"%s","username":"%s","phase":"answering","platform":"%s","round":%s,"at":%s,"receivedAt":%s%s}\n' \
    "$1" "$2" "$3" "$4" "$5" "$5" "$failed"
}
{
  # ios-a: 200 and 400 ms; its round-2 photo is shown again later (a remount): only the first counts, whatever the line
  # order; a resume paints round 2 again: still one round, timed from its first paint
  paint PH ios-a ios 1 1000; shown PH ios-a ios 1 1200
  shown PH ios-a ios 2 9000; paint PH ios-a ios 2 5000; shown PH ios-a ios 2 5400; paint PH ios-a ios 2 7000 resume
  # ios-b: a slow photo, 3.5 s behind its answering paint
  paint PH ios-b ios 1 1000; shown PH ios-b ios 1 4500
  # android-a: 100 ms; round 2's photo never drew; round 3's has no answering paint (rejoined at the reveal): no time,
  # nor for ios-b (two devices with only photo lines in round 3: no answering skew either); round 4 never showed one
  paint PH android-a android 1 1000; shown PH android-a android 1 1100
  paint PH android-a android 2 5000; shown PH android-a android 2 5050 failed
  shown PH android-a android 3 9999; shown PH ios-b ios 3 7777
  # android-a stays on round 4 until its reveal and never shows the photo: missing
  paint PH android-a android 4 12000; phase_ack PH android-a android reveal 4 21000
  # Rounds with no photo the device left or may have been offline in: missingLeft, never a warning. android-a's screen
  # leaves during round 5's answering (no later ack: leave, kick, game over); ios-b rejoins round 2 in answering (a
  # resumed paint) before its live reveal, and round 6 straight at the reveal
  paint PH android-a android 5 30000
  paint PH ios-b ios 2 5000; paint PH ios-b ios 2 6000 resume; phase_ack PH ios-b ios reveal 2 9000
  paint PH ios-b ios 6 40000; phase_ack PH ios-b ios reveal 6 49000 resume
  # Play again in the same room: round 1 again. android-a: 300 ms; ios-a plays it to the scores and never shows it
  # (game 1's round-1 photo is not it): missing; ios-b's photo has no round 1 of this game painted (game 1's is minutes
  # older): no time
  paint PH android-a android 1 200000; shown PH android-a android 1 200300
  paint PH ios-a ios 1 200000; phase_ack PH ios-a ios scores 1 212000
  shown PH ios-b ios 1 200050
  # another game's photo doesn't count
  shown OTHER ios-a ios 1 999999
} >"$TMP/photo.jsonl"
out="$(node "$SKEW" "$TMP/photo.jsonl" PH 2>"$TMP/photo.err")"; rc=$?
[ $rc = 0 ] && ok "photo summary exits 0 (warnings don't fail it)" || ko "photo summary exits 0" "rc=$rc"
[ "$(jget photoVisible.p95BoundMs <<<"$out")" = 3000 ] && ok "photo-visible bound is 3 s p95" || ko "photo-visible bound" "$out"
[ "$(jget photoVisible.platforms.ios <<<"$out")" = '{"n":3,"p50":400,"p95":3500,"max":3500,"failed":0,"missing":1,"missingLeft":2}' ] \
  && ok "ios: first answering paint → first photo shown, per round and game; rejoined rounds are missingLeft" \
  || ko "ios photo visible" "$out"
[ "$(jget photoVisible.platforms.android <<<"$out")" = '{"n":2,"p50":100,"p95":300,"max":300,"failed":1,"missing":1,"missingLeft":1}' ] \
  && ok "android: failed photo counted, not timed; played through with no photo is missing, left is missingLeft" \
  || ko "android photo visible" "$out"
[ "$(jget warnings <<<"$out")" = '["photoVisible android: 1 photo(s) failed to draw","photoVisible android: 1 round(s) painted with no photo shown","photoVisible ios: p95 3500 ms > 3000 ms","photoVisible ios: 1 round(s) painted with no photo shown"]' ] \
  && ok "slow p95, failed and missing photos are warnings" || ko "photo warnings" "$out"
grep -q "WARN photoVisible ios: p95 3500 ms > 3000 ms" "$TMP/photo.err" \
  && grep -q "WARN photoVisible android: 1 round(s) painted with no photo shown" "$TMP/photo.err" \
  && ok "warnings printed to stderr (stdout stays JSON)" || ko "warnings on stderr" "$(cat "$TMP/photo.err")"
[ "$(jget phases.answering <<<"$out")" = '{"instances":2,"p50":0,"p95":0,"max":0}' ] \
  && ok "photo lines are not phase acks" || ko "photo lines are not phase acks" "$out"

# Answering painted, then the reveal, and no photo line at all: a spinner all round
{ paint MISS ios-a android 1 1000; phase_ack MISS ios-a android reveal 1 9000; } >"$TMP/missing.jsonl"
out="$(node "$SKEW" "$TMP/missing.jsonl" MISS 2>"$TMP/photo.err")"
[ "$(jget photoVisible.platforms.android <<<"$out")" = '{"n":0,"p50":null,"p95":null,"max":null,"failed":0,"missing":1,"missingLeft":0}' ] \
  && grep -q "WARN photoVisible android: 1 round(s) painted with no photo shown" "$TMP/photo.err" \
  && ok "answering and reveal painted, no photo line: missing 1 and a WARN" || ko "missing photo" "$out $(cat "$TMP/photo.err")"
# Answering painted, then nothing more of that round (the screen left): missingLeft, no warning
paint LEFT ios-a android 1 1000 >"$TMP/left.jsonl"
out="$(node "$SKEW" "$TMP/left.jsonl" LEFT 2>"$TMP/photo.err")"
[ "$(jget photoVisible.platforms.android <<<"$out")" = '{"n":0,"p50":null,"p95":null,"max":null,"failed":0,"missing":0,"missingLeft":1}' ] \
  && [ "$(jget warnings <<<"$out")" = '[]' ] && [ ! -s "$TMP/photo.err" ] \
  && ok "screen left during answering: missingLeft, no WARN" || ko "left during answering" "$out $(cat "$TMP/photo.err")"
# Answering painted, then a rejoin into answering before the live reveal: it may have been offline when the photo drew
{ paint OFF ios-a ios 1 1000; paint OFF ios-a ios 1 4000 resume; phase_ack OFF ios-a ios reveal 1 9000; } >"$TMP/off.jsonl"
out="$(node "$SKEW" "$TMP/off.jsonl" OFF 2>"$TMP/photo.err")"
[ "$(jget photoVisible.platforms.ios.missingLeft <<<"$out")" = 1 ] && [ "$(jget photoVisible.platforms.ios.missing <<<"$out")" = 0 ] \
  && [ ! -s "$TMP/photo.err" ] \
  && ok "rejoined during answering (maybe offline): missingLeft, no WARN" || ko "offline during answering" "$out $(cat "$TMP/photo.err")"
out="$(node "$SKEW" "$TMP/telemetry.jsonl" ROOM1 2>/dev/null)"
[ "$(jget photoVisible.platforms <<<"$out")" = '{"unknown":{"n":0,"p50":null,"p95":null,"max":null,"failed":0,"missing":0,"missingLeft":4}}' ] \
  && ok "paints without a platform count under unknown" || ko "unknown platform" "$out"
out="$(node "$SKEW" "$TMP/telemetry.jsonl" NOPE 2>"$TMP/photo.err")"
[ "$(jget photoVisible.platforms <<<"$out")" = '{}' ] && [ "$(jget warnings <<<"$out")" = '[]' ] && [ ! -s "$TMP/photo.err" ] \
  && ok "nothing painted: empty photoVisible, no warnings" || ko "nothing painted" "$out $(cat "$TMP/photo.err")"

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
[ "$(node "$SKEW" "$RUNS/run1/telemetry.jsonl" ROOM1 2>/dev/null)" = "$(node "$SKEW" "$TMP/telemetry.jsonl" ROOM1 2>/dev/null)" ] \
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
