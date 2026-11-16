#!/usr/bin/env bash
# `lab.sh play --device-host` (EXP-390): the one selected device creates the room, its flow posts the room code to
# play's loopback listener (CODE_SINK_URL) and the bots join that code. With stub bots/maestro and a fake devices.json
# (the listener is the real one, on loopback): no devices, servers or other network. Covers the arguments it refuses
# (several devices, another server, --rounds, fewer than 3 bots, --name-prefix), the env the device's flow gets, the
# listener's answers (only a room code of the server's alphabet and length, the first one kept), the bots joining the
# posted code, a flow that ends without posting, one still running when the wait ends (stopped with its children) and
# one that fails after posting (the bots are stopped instead of waited out), and the invocation the flow documents.
# Run: qa/lab/tests/lab-device-host.test.sh
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
REAL_NODE="$(command -v node)"
# node stub: bots.mjs logs its argv and writes a passing summary (like a --code room, it never writes --code-file),
# then lingers STUB_BOTS_LINGER seconds; anything else (the code listener, the summary print) is the real node
cat >"$TMP/bin/node" <<EOF
#!/usr/bin/env bash
[[ "\$1" == *bots.mjs ]] || exec "$REAL_NODE" "\$@"
echo "\$*" >>"\$STUB_LOG/node.args"
out=""; while [ \$# -gt 0 ]; do [ "\$1" = --out ] && out=\$2; shift; done
echo '{"summary":{"pass":true}}' >"\$out"
echo \$\$ >"\$STUB_LOG/bots.pid"
exec sleep "\${STUB_BOTS_LINGER:-0}"
EOF
# maestro stub: logs its argv; unless STUB_NO_POST, POSTs each of STUB_POSTS (default: the code, another code, the
# code again) to its CODE_SINK_URL like device-host-start.yaml does, recording the listener's statuses, then waits for
# the bots to start; with STUB_HANG it instead hangs that many seconds in a child process (a Maestro stuck before its
# post; its pid and the child's are recorded); exits STUB_MAESTRO_RC (default 0)
cat >"$TMP/bin/maestro" <<'EOF'
#!/usr/bin/env bash
[ "$1" = --version ] && { echo 2.11.0; exit 0; }
echo "$*" >>"$STUB_LOG/maestro.args"
sink=""; while [ $# -gt 0 ]; do case $2 in CODE_SINK_URL=*) sink=${2#CODE_SINK_URL=};; esac; shift; done
if [ -n "${STUB_HANG:-}" ]; then
  echo $$ >"$STUB_LOG/maestro.pid"; sleep "$STUB_HANG" & echo $! >"$STUB_LOG/maestro-child.pid"; wait
elif [ -z "${STUB_NO_POST:-}" ]; then
  for code in ${STUB_POSTS:-K7MQ4X ZZZZZZ K7MQ4X}; do
    curl -s -o /dev/null -w '%{http_code}\n' -X POST --data "$code" "$sink" >>"$STUB_LOG/post.status"
  done
  for _ in $(seq 50); do [ -s "$STUB_LOG/bots.pid" ] && break; sleep 0.1; done
fi
exit "${STUB_MAESTRO_RC:-0}"
EOF
chmod +x "$TMP/bin/node" "$TMP/bin/maestro"
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP"
MAESTRO="$TMP/bin/maestro"

play() { # RUN_ID, args... -> runs cmd_play in a subshell under lab.sh's own shell options, returns its status
  rm -f "$TMP/node.args" "$TMP/maestro.args" "$TMP/post.status" "$TMP/bots.pid" "$TMP/maestro.pid" "$TMP/maestro-child.pid"
  ( set -euo pipefail; RUN_ID=$1; shift; cmd_play "$@" ) >"$TMP/play.out" 2>&1
}
maestro_env() { # KEY -> the value of the -e KEY=... the device's flow got
  grep -oE -- "-e $1=[^ ]*" "$TMP/maestro.args" | head -1 | sed "s/^-e $1=//"
}

# ── Arguments it refuses ──
play bad-devices --device-host --devices all --flow device-host-start
[ $? != 0 ] && grep -q "exactly one device" "$TMP/play.out" && [ ! -f "$TMP/maestro.args" ] \
  && ok "--device-host refuses two devices" || ko "--device-host refuses two devices" "$(cat "$TMP/play.out")"
play bad-port --device-host --devices ios-a --port 3101 --flow device-host-start
[ $? != 0 ] && grep -q "shared server :3000" "$TMP/play.out" && [ ! -f "$TMP/node.args" ] \
  && ok "--device-host refuses another server (the device's room is on :3000)" || ko "--device-host refuses --port" "$(cat "$TMP/play.out")"
play bad-rounds --device-host --devices ios-a --rounds 10 --flow device-host-start
[ $? != 0 ] && grep -q "default rounds, drop --rounds" "$TMP/play.out" && [ ! -f "$TMP/maestro.args" ] \
  && ok "--device-host refuses --rounds (the device's lobby picks none)" || ko "--device-host refuses --rounds" "$(cat "$TMP/play.out")"
# The flow removes bot3 and guesses bot1: fewer bots or renamed ones can't play it
play bad-bots --device-host --devices ios-a --bots 2 --flow device-host-start
[ $? != 0 ] && grep -q "at least 3 bots" "$TMP/play.out" && [ ! -f "$TMP/maestro.args" ] \
  && ok "--device-host refuses fewer than 3 bots" || ko "--device-host refuses --bots 2" "$(cat "$TMP/play.out")"
for prefix_args in "--name-prefix x-" "--chaos 0.1 --name-prefix=x-"; do
  play bad-prefix --device-host --devices ios-a --flow device-host-start --bot-args "$prefix_args"
  [ $? != 0 ] && grep -q "drop --name-prefix" "$TMP/play.out" && [ ! -f "$TMP/maestro.args" ] \
    && ok "--device-host refuses a bot name prefix ($prefix_args)" || ko "--device-host refuses '$prefix_args'" "$(cat "$TMP/play.out")"
done

# ── The device posts its code, the bots join it ──
play dh1 --device-host --devices ios-a --bots 3 --flow device-host-start --bot-args "--chaos 0.1"
rc=$?
[ $rc = 0 ] && grep -q "RUN dh1 PASS" "$TMP/play.out" && grep -q '"pass": true' "$TMP/play.out" \
  && ok "device-hosted play passes (summary + PASS line)" || ko "device-hosted play passes" "rc=$rc $(cat "$TMP/play.out")"
[ "$(wc -l <"$TMP/maestro.args" | tr -d ' ')" = 1 ] && grep -q "maestro/device-host-start.yaml" "$TMP/maestro.args" \
  && ok "only the hosting device runs the flow" || ko "only the hosting device runs the flow" "$(cat "$TMP/maestro.args")"
[ "$(maestro_env USERNAME)" = ios-a ] && [ -n "$(maestro_env METRO_URL)" ] && ! grep -q "GAME_CODE=" "$TMP/maestro.args" \
  && grep -q "the lobby's default rounds" "$TMP/play.out" \
  && ok "the flow gets USERNAME and METRO_URL, no GAME_CODE; the log says the lobby picks the rounds" || ko "the device flow's env" "$(cat "$TMP/maestro.args")"
[[ "$(maestro_env CODE_SINK_URL)" =~ ^http://127\.0\.0\.1:[0-9]+/room-code$ ]] \
  && ok "the flow gets a loopback CODE_SINK_URL" || ko "the flow gets a loopback CODE_SINK_URL" "$(maestro_env CODE_SINK_URL)"
[ "$(tr '\n' ' ' <"$TMP/post.status")" = "200 409 200 " ] && [ "$(cat "$RUNS/dh1/code")" = K7MQ4X ] \
  && ok "the listener keeps the first code: another one is a conflict (409), the same one again is fine" \
  || ko "the listener keeps the first code" "status=$(tr '\n' ' ' <"$TMP/post.status") code=$(cat "$RUNS/dh1/code")"
[ "$(wc -l <"$TMP/node.args" | tr -d ' ')" = 1 ] && grep -q -- "--bots 3 --code K7MQ4X --chaos 0.1" "$TMP/node.args" \
  && ! grep -qE -- "--host|--wait-players|--code-file" "$TMP/node.args" \
  && ok "the bots join the posted code (no --host, no --code-file over the device's), with --bot-args" \
  || ko "the bots join the posted code" "$(cat "$TMP/node.args")"
grep -q "room K7MQ4X (created by ios-a)" "$TMP/play.out" && ok "play names the room the device created" || ko "play logs the device's room"
port="$(cat "$RUNS/dh1/code.sink-port")"
for _ in $(seq 10); do curl -s -o /dev/null "http://127.0.0.1:$port/" || break; sleep 0.1; done
! curl -s -o /dev/null "http://127.0.0.1:$port/" \
  && ok "the listener is stopped at the end" || ko "the listener is stopped at the end" "port $port still answers"

# ── Only a room code is taken: the server's alphabet and length (no 0/O/1/I/L, upper case) ──
STUB_POSTS="K7MQ4 K7MQ4XY K7MQ0X K7MQ4x hello K7MQ4X" play dh-bad --device-host --devices ios-a --flow device-host-start
[ "$(tr '\n' ' ' <"$TMP/post.status")" = "400 400 400 400 400 200 " ] && [ "$(cat "$RUNS/dh-bad/code")" = K7MQ4X ] \
  && ok "the listener refuses what is not a room code (400: length, alphabet, case) and takes the code after" \
  || ko "the listener refuses non-codes" "$(tr '\n' ' ' <"$TMP/post.status")"
server_alphabet="$(sed -nE 's/^export const ROOM_CODE_ALPHABET = "([^"]+)";$/\1/p' "$HERE/../../../Server/managers/roomCode.ts")"
server_length="$(sed -nE 's/^export const ROOM_CODE_LENGTH = ([0-9]+);$/\1/p' "$HERE/../../../Server/managers/roomCode.ts")"
[ "$server_alphabet" = "$ROOM_CODE_ALPHABET" ] && [ "$server_length" = "$ROOM_CODE_LENGTH" ] \
  && ok "the listener's room code is the server's ($ROOM_CODE_LENGTH of $ROOM_CODE_ALPHABET)" \
  || ko "the listener's room code is the server's" "server: $server_length of '$server_alphabet'"

# ── The flow is still running when the wait for its code ends: it is stopped with its children ──
LAB_DEVICE_ROOM_CODE_TIMEOUT=2 STUB_HANG=60 play dh-hang --device-host --devices ios-a --flow device-host-start
rc=$?
maestro_pid="$(cat "$TMP/maestro.pid" 2>/dev/null)"; child_pid="$(cat "$TMP/maestro-child.pid" 2>/dev/null)"
sleep 0.5
[ $rc != 0 ] && grep -q "the device did not post its room code" "$TMP/play.out" && [ -n "$maestro_pid" ] \
  && [ -n "$child_pid" ] && ! kill -0 "$maestro_pid" 2>/dev/null && ! kill -0 "$child_pid" 2>/dev/null \
  && ok "a flow that never posted in time is stopped, its Maestro and that one's child too" \
  || ko "a hung flow is stopped on the timeout" "rc=$rc maestro=$maestro_pid child=$child_pid $(cat "$TMP/play.out")"
[ -n "$child_pid" ] && kill "$child_pid" 2>/dev/null   # never leave the stub's sleep behind

# ── The flow ends without posting: play fails at once, no bots ──
export LAB_DEVICE_ROOM_CODE_TIMEOUT=20
STUB_NO_POST=1 STUB_MAESTRO_RC=1 play dh-nopost --device-host --devices ios-a --flow device-host-start
rc=$?
[ $rc != 0 ] && grep -q "the device did not post its room code" "$TMP/play.out" && [ ! -f "$TMP/node.args" ] \
  && ok "a flow that ended without posting fails the run, no bots started" || ko "a flow that never posts fails" "rc=$rc $(cat "$TMP/play.out")"

# ── The flow fails after posting: the bots are stopped, not waited out ──
start=$SECONDS
STUB_MAESTRO_RC=1 STUB_BOTS_LINGER=30 play dh-fail --device-host --devices ios-a --flow device-host-start
rc=$?
[ $rc != 0 ] && grep -q "hosting device's flow failed: stopping the bots" "$TMP/play.out" && [ $((SECONDS - start)) -lt 20 ] \
  && ok "a hosting flow that failed stops the bots and fails the run" || ko "a failed hosting flow stops the bots" "rc=$rc $((SECONDS - start)) s $(cat "$TMP/play.out")"
pid="$(cat "$TMP/bots.pid" 2>/dev/null)"
[ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && ok "the stopped bots are gone" || ko "the stopped bots are gone" "pid=$pid"
unset LAB_DEVICE_ROOM_CODE_TIMEOUT

# ── The flow documents the invocation; the wait for its code covers the lobby budget ──
grep -qF -- "qa/lab/lab.sh play --device-host --flow device-host-start --devices <label> --bots 3" "$MAESTRO_DIR/device-host-start.yaml" \
  && ok "device-host-start.yaml documents its play invocation" || ko "device-host-start.yaml documents its play invocation"
grep -qF 'http.post(CODE_SINK_URL, { body: maestro.copiedText })' "$MAESTRO_DIR/device-host-start.yaml" \
  && ok "device-host-start.yaml posts the copied room code to CODE_SINK_URL" || ko "device-host-start.yaml posts to CODE_SINK_URL"
[ "$DEVICE_ROOM_CODE_TIMEOUT_S" -ge $((LOBBY_WAIT_MS / 1000)) ] \
  && ok "the code wait ($DEVICE_ROOM_CODE_TIMEOUT_S s) covers a stuck boot and its retry (LOBBY_WAIT_MS)" \
  || ko "the code wait covers LOBBY_WAIT_MS" "$DEVICE_ROOM_CODE_TIMEOUT_S s"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
