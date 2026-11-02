#!/usr/bin/env bash
# Command line of qa/lab/bots.mjs (EXP-197): --help and bad arguments exit before any network activity (also bad
# --rounds, EXP-203, --drop-round/--drop-rounds, EXP-096, --name-prefix, EXP-207, --leave-round/--kick, EXP-139, and
# --hold, EXP-303),
# and the server constants it (and its checks, bots-analysis.mjs) mirrors match the server.
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
  local want=$1 label=$2 before; shift 2
  before="$(conns)"   # valid runs in between do connect
  out="$(SERVER_URL="$URL" node "$BOTS" "$@" 2>"$TMP/err")"; rc=$?
  err="$(cat "$TMP/err")"
  [ "$rc" = "$want" ] && [ "$(conns)" = "$before" ] && ok "$label" || ko "$label" "rc=$rc want=$want conns=$(conns)-$before err=$err"
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

# ── --code: a room code (6 characters of the server's alphabet, any case) (EXP-198) ──
run 2 "numeric --code exits 2" --bots 1 --code 123456
[[ "$err" == *'--code "123456" is not a room code'* ]] && ok "malformed --code is named" || ko "malformed --code is named" "$err"
run 2 "short --code exits 2" --bots 1 --code K7MQ4
run 2 "non-ASCII --code exits 2 (no ß → SS alias)" --bots 1 --code "K7MQß"
SERVER_URL="$URL" node "$BOTS" --bots 1 --code k7mq4x --timeout 1 >/dev/null 2>"$TMP/err"
err="$(cat "$TMP/err")"
[[ "$err" != *"not a room code"* ]] && ok "lowercase --code is accepted" || ko "lowercase --code is accepted" "$err"

# ── --rounds: only the round counts the server accepts (EXP-203) ──
for bad in 5 0 abc 3.5 -10; do
  run 2 "--rounds $bad exits 2" --bots 2 --host --rounds "$bad"
  [[ "$err" == *"--rounds \"$bad\" is not a round count the server accepts"* ]] && ok "--rounds $bad is named" || ko "--rounds $bad is named" "$err"
done
for good in 3 10 15 20; do
  SERVER_URL="$URL" node "$BOTS" --bots 1 --host --rounds "$good" --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "--rounds $good is accepted" || ko "--rounds $good is accepted" "$(cat "$TMP/err")"
done

# ── --drop-rounds: several planned drops; --drop-round stays a single one (EXP-096) ──
run 2 "--drop-rounds with a non-number exits 2" --bots 2 --host --drop-rounds 2,x
[[ "$err" == *'--drop-rounds "2,x" is not a list of round numbers'* ]] && ok "bad --drop-rounds is named" || ko "bad --drop-rounds is named" "$err"
run 2 "--drop-rounds with round 0 exits 2" --bots 2 --host --drop-rounds 0,2
run 2 "--drop-rounds with an empty item exits 2" --bots 2 --host --drop-rounds 2,,4
run 2 "--drop-round with a list exits 2" --bots 2 --host --drop-round 2,3
[[ "$err" == *"several drops: --drop-rounds"* ]] && ok "--drop-round list points to --drop-rounds" || ko "--drop-round list points to --drop-rounds" "$err"
run 2 "--drop-round abc exits 2" --bots 2 --host --drop-round abc
run 2 "--drop-round with --drop-rounds exits 2" --bots 2 --host --drop-round 2 --drop-rounds 3,4
run 2 "--drop-rounds with --drop-on-turn exits 2" --bots 2 --host --drop-rounds 3,4 --drop-on-turn
for good in "--drop-rounds 4,2,2" "--drop-rounds 7" "--drop-round 2"; do
  # shellcheck disable=SC2086
  SERVER_URL="$URL" node "$BOTS" --bots 2 --host $good --drop-secs 3 --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "$good is accepted" || ko "$good is accepted" "$(cat "$TMP/err")"
done

# ── Server constants bots.mjs and its checks (bots-analysis.mjs) mirror (the server is TypeScript, they plain node) ──
SERVER_SRC="$HERE/../../../Server"
ANALYSIS="$HERE/../bots-analysis.mjs"
mirrors() { # server file (from Server/), our file, our const, server const: same initializer in both (digit separators ignored)
  local theirs ours
  theirs="$(sed -n "s/^\(export \)\{0,1\}const $4 = \([^;]*\);.*/\2/p" "$SERVER_SRC/$1")"
  ours="$(sed -n "s/^\(export \)\{0,1\}const $3 = \([^;]*\);.*/\2/p" "$2")"
  [[ -n "$theirs" && "${ours//_/}" == "${theirs//_/}" ]] && ok "$3 matches the server's $4" || ko "$3 matches the server's $4" "ours=[$ours] server=[$theirs]"
}
mirrors managers/RoomManager.ts "$BOTS" ROUND_OPTIONS ROUND_OPTIONS
mirrors managers/RoomManager.ts "$BOTS" QA_ROUNDS QA_ROUNDS
mirrors managers/roomCode.ts "$BOTS" ROOM_CODE_ALPHABET ROOM_CODE_ALPHABET
mirrors managers/roomCode.ts "$BOTS" ROOM_CODE_LENGTH ROOM_CODE_LENGTH
mirrors managers/GameEngine.ts "$ANALYSIS" MAX_PAUSES MAX_PAUSES
mirrors managers/GameEngine.ts "$ANALYSIS" MAX_TOTAL_PAUSES MAX_TOTAL_PAUSES
# Every /upload in-flight cap the server reads from the environment is named by bots.mjs's 429/503 hint
for knob in $(grep -o 'envInt("UPLOAD_INFLIGHT_[A-Z_]*"' "$SERVER_SRC/middlewares/uploadInFlight.ts" | cut -d'"' -f2); do
  grep -qw "$knob" "$BOTS" && ok "upload refusal hint names $knob" || ko "upload refusal hint names $knob"
done
mirrors managers/GameEngine.ts "$ANALYSIS" PAUSE_GRACE_MS PAUSE_GRACE
mirrors managers/GameEngine.ts "$ANALYSIS" ANSWER_GRACE_MS ANSWER_GRACE
mirrors managers/GameEngine.ts "$ANALYSIS" OWNER_RETURN_WINDOW_MS OWNER_RETURN_WINDOW
mirrors managers/playerName.ts "$BOTS" MAX_USERNAME_LENGTH MAX_USERNAME_LENGTH
mirrors managers/RoomManager.ts "$ANALYSIS" DISCONNECT_GRACE_MS DISCONNECT_GRACE   # bots.mjs imports it from there
# Every stored-photo refusal scope (uploadStore.ts) is named by the hint with its envInt knob (EXP-260): a 503
# "storage" from a big load test must point at UPLOAD_STORED_MAX, a 429 "lobby-ip" at UPLOAD_LOBBY_PER_IP_MAX
STORE_SRC="$SERVER_SRC/middlewares/uploadStore.ts"
scopes="$(sed -n 's/^ *scope: \(".*"\);$/\1/p' "$STORE_SRC" | grep -o '"[a-z-]*"' | tr -d '"')"
[ -n "$scopes" ] && ok "uploadStore.ts refusal scopes found ($(echo $scopes))" || ko "uploadStore.ts refusal scopes found"
storage_hint="$(grep 'const storageKnob = ' "$BOTS")"
for scope in $scopes; do
  knob="$(sed -nE "s/.*(\"$scope\"|[ {]$scope): \"([A-Z_]+)\".*/\2/p" <<<"$storage_hint")"   # { storage: "KNOB", "lobby-ip": "KNOB" }
  [ -n "$knob" ] && grep -q "envInt(\"$knob\"" "$STORE_SRC" && ok "upload refusal hint for scope $scope names $knob" \
    || ko "upload refusal hint for scope $scope names an uploadStore.ts knob" "hint=[$storage_hint] knob=[$knob]"
done

# ── --leave-round / --kick: players out of the room (EXP-139) ──
for bad in 0 abc 2,3 -1; do
  run 2 "--leave-round $bad exits 2" --bots 3 --host --leave-round "$bad" --timeout 1
  [[ "$err" == *"--leave-round \"$bad\" is not a round number"* ]] && ok "--leave-round $bad is named" || ko "--leave-round $bad is named" "$err"
done
run 2 "--leave-owner without --leave-round exits 2" --bots 3 --host --leave-owner --timeout 1
[[ "$err" == *"--leave-owner needs --leave-round"* ]] && ok "--leave-owner without --leave-round is named" || ko "--leave-owner without --leave-round is named" "$err"
run 2 "--kick without --host exits 2" --bots 2 --code K7MQ4X --kick bot2 --timeout 1
[[ "$err" == *"--kick needs --host"* ]] && ok "--kick without --host is named" || ko "--kick without --host is named" "$err"
run 2 "--kick of the host itself exits 2" --bots 3 --host --kick bot1 --timeout 1
[[ "$err" == *"the host can't remove itself"* ]] && ok "--kick of the host is named" || ko "--kick of the host is named" "$err"
run 2 "--kick with several rooms exits 2" --bots 3 --host --rooms 2 --kick bot2 --timeout 1
run 2 "--kick of a name longer than the server's 15 exits 2" --bots 3 --host --kick abcdefghijklmnop --timeout 1
run 2 "--kick of an empty name exits 2" --bots 3 --host --kick "" --timeout 1
# Lobby only (EXP-316): the server ignores remove-player once a game started, so the old NAME@R form is refused
run 2 "--kick NAME@R (mid-game) exits 2" --bots 3 --host --rounds 3 --kick bot3@2 --timeout 1
[[ "$err" == *"--kick \"bot3@2\": the host can only remove players in the lobby"* ]] && ok "--kick NAME@R is named as lobby only" || ko "--kick NAME@R is named as lobby only" "$err"
run 2 "--kick of a name with surrounding spaces exits 2" --bots 3 --host --kick " ios-a" --timeout 1
# A planned exit must fall inside the hosted game (--rounds), or it never happens
run 2 "--leave-round beyond --rounds exits 2" --bots 3 --host --rounds 3 --leave-round 4 --timeout 1
[[ "$err" == *"--leave-round: round 4 is beyond the game's 3 rounds"* ]] && ok "--leave-round beyond --rounds is named" || ko "--leave-round beyond --rounds is named" "$err"
run 2 "--leave-round beyond the default 10 rounds exits 2" --bots 3 --host --leave-round 11 --timeout 1
for good in "--rounds 3 --leave-round 3"; do
  # shellcheck disable=SC2086
  SERVER_URL="$URL" node "$BOTS" --bots 3 --host $good --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "$good is accepted" || ko "$good is accepted" "$(cat "$TMP/err")"
done
# Joining a room (--code): its length is not ours to know
SERVER_URL="$URL" node "$BOTS" --bots 2 --code K7MQ4X --leave-round 15 --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
[[ "$rc" != 2 ]] && ok "--leave-round 15 with --code is accepted" || ko "--leave-round 15 with --code is accepted" "$(cat "$TMP/err")"
for good in "--leave-round 2" "--leave-round 2 --leave-owner" "--kick bot3" "--kick ios-a" "--kick a@b"; do
  # shellcheck disable=SC2086
  SERVER_URL="$URL" node "$BOTS" --bots 3 --host $good --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "$good is accepted" || ko "$good is accepted" "$(cat "$TMP/err")"
done
[[ "$(node "$BOTS" --help)" == *"--leave-round R [--leave-owner]"* && "$(node "$BOTS" --help)" == *"--kick NAME "* ]] && ok "--help lists --leave-round, --leave-owner and --kick" || ko "--help lists --leave-round, --leave-owner and --kick"

# ── Loopback servers only: QA traffic never leaves the machine (EXP-220) ──
# Reserved/unresolvable hosts only, so a broken guard can't reach a real server (--timeout 1 as well)
for bad in "http://192.0.2.1:3000" "https://example.invalid" "http://10.0.0.2:3000" "http://localhost.example.invalid:3000" \
  "http://127.0.0.1.example.invalid:3000" "http://user@example.invalid:3000" "ftp://localhost:3000" "not-a-url"; do
  run 2 "--server $bad exits 2" --bots 1 --host --server "$bad" --timeout 1
  [[ "$err" == *"is not a local lab server"* ]] && ok "--server $bad is named" || ko "--server $bad is named" "$err"
done
out="$(SERVER_URL="http://192.0.2.1:3000" node "$BOTS" --bots 1 --host --timeout 1 2>&1 >/dev/null)"; rc=$?
[ "$rc" = 2 ] && [[ "$out" == *'(from $SERVER_URL) is not a local lab server'* ]] && ok "non-loopback \$SERVER_URL exits 2" || ko "non-loopback \$SERVER_URL exits 2" "rc=$rc $out"
for good in "http://localhost:$PORT" "http://127.0.0.1:$PORT/"; do
  SERVER_URL="$URL" node "$BOTS" --bots 1 --host --server "$good" --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "--server $good is accepted" || ko "--server $good is accepted" "$(cat "$TMP/err")"
done

# ── --name-prefix: two bots processes in one room without name clashes (EXP-207) ──
# (--timeout 1 everywhere: a value wrongly accepted must not keep the test waiting for a game)
for bad in "a b" "bot!" "é-" ""; do
  run 2 "--name-prefix '$bad' exits 2" --bots 2 --code K7MQ4X --name-prefix "$bad" --timeout 1
done
[[ "$err" == *"--name-prefix"* ]] && ok "bad --name-prefix is named" || ko "bad --name-prefix is named" "$err"
run 2 "--name-prefix that makes a name longer than the server's 15 exits 2" --bots 12 --code K7MQ4X --name-prefix abcdefghijk --timeout 1
[[ "$err" == *'"abcdefghijkbot12" exceeds the server'* ]] && ok "too long --name-prefix names the longest bot" || ko "too long --name-prefix named" "$err"
# 8 + "r10-" + "bot2" = 16 characters
run 2 "--name-prefix length counts the room prefix of --rooms" --bots 2 --host --rooms 11 --name-prefix abcdefgh --timeout 1
# The longest accepted: 10 + "bot12" and 7 + "r10-" + "bot2" = 15 characters
for good in "--bots 12 --code K7MQ4X --name-prefix abcdefghij" "--bots 2 --host --rooms 11 --name-prefix abcdefg"; do
  # shellcheck disable=SC2086
  SERVER_URL="$URL" node "$BOTS" $good --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "15-character names are accepted ($good)" || ko "15-character names accepted ($good)" "$(cat "$TMP/err")"
done
SERVER_URL="$URL" node "$BOTS" --bots 2 --code K7MQ4X --name-prefix b_2- --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
[[ "$rc" != 2 ]] && ok "--name-prefix b_2- is accepted" || ko "--name-prefix b_2- is accepted" "$(cat "$TMP/err")"
[[ "$(node "$BOTS" --help)" == *"--name-prefix P"* ]] && ok "--help lists --name-prefix" || ko "--help lists --name-prefix"

# ── --quit-after-game-over: the next game drops a bot that quit at game-over (EXP-151) ──
run 2 "--quit-after-game-over without --host exits 2" --bots 3 --code K7MQ4X --quit-after-game-over --timeout 1
[[ "$err" == *"--quit-after-game-over needs --host"* ]] && ok "--quit-after-game-over without --host is named" || ko "--quit-after-game-over without --host is named" "$err"
run 2 "--quit-after-game-over with 2 bots exits 2" --bots 2 --host --quit-after-game-over --timeout 1
[[ "$err" == *"needs --bots 3 or more"* ]] && ok "--quit-after-game-over with 2 bots is named" || ko "--quit-after-game-over with 2 bots is named" "$err"
run 2 "--quit-after-game-over with --play-again-linger exits 2" --bots 3 --host --quit-after-game-over --play-again-linger 5 --timeout 1
SERVER_URL="$URL" node "$BOTS" --bots 3 --host --rounds 3 --quit-after-game-over --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
[[ "$rc" != 2 ]] && ok "--quit-after-game-over with --host and 3 bots is accepted" || ko "--quit-after-game-over accepted" "$(cat "$TMP/err")"
[[ "$(node "$BOTS" --help)" == *"--quit-after-game-over"* ]] && ok "--help lists --quit-after-game-over" || ko "--help lists --quit-after-game-over"

# ── --drop-on-turn is a known flag (EXP-226) ──
SERVER_URL="$URL" node "$BOTS" --bots 2 --host --drop-round 1 --drop-secs 3 --drop-on-turn --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
err="$(cat "$TMP/err")"
[[ "$rc" != 2 && "$err" != *"unknown option"* ]] && ok "--drop-on-turn is accepted" || ko "--drop-on-turn is accepted" "rc=$rc err=$err"

# ── --hold P: the photo owner holds the scoreboard (EXP-303) ──
for bad in abc 1.5 -0.1 ""; do
  run 2 "--hold '$bad' exits 2" --bots 3 --host --hold "$bad" --timeout 1
  [[ "$err" == *"--hold \"$bad\" is not a probability"* ]] && ok "--hold '$bad' is named" || ko "--hold '$bad' is named" "$err"
done
for good in "--hold 0" "--hold 1" "--hold 0.3 --chaos 0.2"; do
  # shellcheck disable=SC2086
  SERVER_URL="$URL" node "$BOTS" --bots 3 --host $good --timeout 1 >/dev/null 2>"$TMP/err"; rc=$?
  [[ "$rc" != 2 ]] && ok "$good is accepted" || ko "$good is accepted" "$(cat "$TMP/err")"
done
[[ "$(node "$BOTS" --help)" == *"--hold P"* ]] && ok "--help lists --hold" || ko "--help lists --hold"
mirrors managers/GameEngine.ts "$BOTS" HOLD_BUDGET_PER_ROUND HOLD_BUDGET_PER_ROUND
mirrors managers/GameEngine.ts "$ANALYSIS" MAX_HOLDS_PER_ROUND MAX_HOLDS_PER_ROUND

# ── A valid run says which server it uses before connecting ──
SERVER_URL="$URL" node "$BOTS" --bots 1 --host --timeout 1 >/dev/null 2>"$TMP/err"
err="$(cat "$TMP/err")"
[[ "$err" == *"bots.mjs: server $URL (from \$SERVER_URL)"* ]] && ok "prints the server in use" || ko "prints the server in use" "$err"
out="$(node "$BOTS" --bots 1 --host --timeout 1 --server "$URL" 2>&1 >/dev/null)"
[[ "$out" == *"bots.mjs: server $URL"* && "$out" != *"shared lab server"* ]] && ok "--server is printed without the default warning" || ko "--server printed" "$out"

echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
