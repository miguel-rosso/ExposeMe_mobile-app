#!/usr/bin/env bash
# `lab.sh play` with a flow whose header says "# lab: cut link <s> (<why>)" (EXP-437): each selected Android device's
# adb reverse :3000 goes through its own qa/lab/link-proxy.mjs (the real one, on loopback, in front of nothing), the
# flow gets LINK_CUT_URL, the reverse points straight at the server again when play ends, and the run fails for a
# device whose link was never cut. With stub bots/maestro/adb and a fake devices.json: no devices or servers. Also the
# header parsing, the flows play refuses (iOS devices, a bad duration), flows without the marker untouched, and the
# header of qa/maestro/link-cut-mid-game.yaml.
# Run: qa/lab/tests/lab-link-cut.test.sh
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
mkdir -p "$TMP/bin" "$QA/lab" "$QA/maestro"
ln -s "$HERE/../link-proxy.mjs" "$QA/lab/link-proxy.mjs"
echo '[{"id":"FAKE-1","label":"ios-a","platform":"ios"},{"id":"emulator-5554","label":"android-a","platform":"android"},
  {"id":"emulator-5556","label":"android-b","platform":"android"}]' >"$DEVICES_JSON"
cut_flow() { # name, header line(s): a flow with that header
  printf '%s\nappId: com.socketNull.ExposeMe\n---\n- runFlow: open-app.yaml\n' "$2" >"$QA/maestro/$1.yaml"
}
cut_flow cut "# lab: cut link 2 (test)"
cut_flow plain "# a flow without the marker"
cut_flow bad-cut "# lab: cut link soon (test)"
cut_flow long-cut "# lab: cut link 601 (test)"
printf 'appId: com.socketNull.ExposeMe\n# lab: cut link 2 (after appId: not a header)\n---\n' >"$QA/maestro/late.yaml"
REAL_NODE="$(command -v node)"
# node stub: bots.mjs logs its argv, writes a room code and a passing summary; anything else (the link proxy, the
# code listener, the summary print) is the real node, except the link proxy of the device named in STUB_PROXY_FAIL,
# which exits at once (a proxy that can't start)
cat >"$TMP/bin/node" <<EOF
#!/usr/bin/env bash
[[ "\$1" == *link-proxy.mjs && -n "\${STUB_PROXY_FAIL:-}" && "\$*" == *"link-\$STUB_PROXY_FAIL."* ]] && exit 1
[[ "\$1" == *bots.mjs ]] || exec "$REAL_NODE" "\$@"
echo "\$*" >>"\$STUB_LOG/node.args"
code_file="" out=""
while [ \$# -gt 0 ]; do case \$1 in --code-file) code_file=\$2; shift;; --out) out=\$2; shift;; esac; shift; done
[ -z "\$code_file" ] || echo ROOM01 >"\$code_file"
echo '{"summary":{"pass":true}}' >"\$out"
EOF
# maestro stub: logs its argv; POSTs its LINK_CUT_URL like link-cut-mid-game.yaml (unless STUB_NO_CUT), recording the
# answer (one line each), and a room code to its CODE_SINK_URL like device-host-start.yaml
cat >"$TMP/bin/maestro" <<'EOF'
#!/usr/bin/env bash
[ "$1" = --version ] && { echo 2.11.0; exit 0; }
echo "$*" >>"$STUB_LOG/maestro.args"
for arg; do case $arg in
  # One write per answer: the devices' flows run in parallel and append to the same file
  LINK_CUT_URL=*) [ -n "${STUB_NO_CUT:-}" ] \
    || echo "$(curl -s -X POST --data cut "${arg#LINK_CUT_URL=}")" >>"$STUB_LOG/cut.replies";;
  CODE_SINK_URL=*) curl -s -o /dev/null -X POST --data K7MQ4X "${arg#CODE_SINK_URL=}";;
esac; done
exit 0
EOF
chmod +x "$TMP/bin/node" "$TMP/bin/maestro"
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP"
MAESTRO="$TMP/bin/maestro"
adbs() { echo "adb -s $*" >>"$TMP/adb.log"; }   # records the reverse and force-stop commands
xcrun() { echo "xcrun $*" >>"$TMP/adb.log"; }

play() { # RUN_ID, args... -> runs cmd_play in a subshell under lab.sh's own shell options, returns its status
  rm -f "$TMP/node.args" "$TMP/maestro.args" "$TMP/adb.log" "$TMP/cut.replies"
  ( set -euo pipefail; RUN_ID=$1; shift; cmd_play "$@" ) >"$TMP/play.out" 2>&1
}
maestro_env_of() { # device id, KEY -> the -e KEY=... that device's flow got
  grep -- "--device $1 " "$TMP/maestro.args" | grep -oE -- "-e $2=[^ ]*" | head -1 | sed "s/^-e $2=//"
}
ports_of() { jq -r "$2" "$RUNS/$1/link-$3.ports.json" 2>/dev/null; } # RUN_ID, jq path, label

# ── Header ──
[ "$(flow_cut_link_seconds "$QA/maestro/cut.yaml")" = 2 ] && ok "header marker: its seconds" || ko "header marker: its seconds"
flow_cut_link_seconds "$QA/maestro/plain.yaml" >/dev/null && ko "no marker: no cut" || ok "no marker: no cut"
flow_cut_link_seconds "$QA/maestro/late.yaml" >/dev/null && ko "marker after appId ignored" || ok "marker after appId ignored"
flow_s="$(flow_cut_link_seconds "$MAESTRO_DIR/link-cut-mid-game.yaml")"
valid_cut_seconds "$flow_s" && ok "link-cut-mid-game.yaml's header cuts the link for $flow_s s" \
  || ko "link-cut-mid-game.yaml has a valid cut link marker" "got '$flow_s'"
proxy_max="$(sed -nE 's/^const MAX_CUT_S = ([0-9]+);.*/\1/p' "$HERE/../link-proxy.mjs")"
[ "$proxy_max" = "$CUT_LINK_MAX_S" ] && ok "lab.sh and link-proxy.mjs allow the same longest cut ($CUT_LINK_MAX_S s)" \
  || ko "CUT_LINK_MAX_S matches link-proxy.mjs's MAX_CUT_S" "lab.sh $CUT_LINK_MAX_S, proxy ${proxy_max:-none}"
grep -q 'play --flow link-cut-mid-game --bots 2 --rounds 10 --devices <android label>' "$MAESTRO_DIR/link-cut-mid-game.yaml" \
  && ok "link-cut-mid-game.yaml documents its invocation" || ko "link-cut-mid-game.yaml documents its invocation"

# ── Refused before any bots start ──
for devices in ios-a ios-a,android-a; do
  play refused-ios --flow cut --devices "$devices" --bots 2
  [ $? != 0 ] && grep -q "only Android devices have" "$TMP/play.out" && grep -q "drop ios-a from --devices" "$TMP/play.out" \
    && [ ! -f "$TMP/node.args" ] && [ ! -f "$TMP/adb.log" ] \
    && ok "a cut-link flow refuses iOS devices (--devices $devices), before any bots or adb" \
    || ko "a cut-link flow refuses iOS devices (--devices $devices)" "$(cat "$TMP/play.out")"
done
for flow in bad-cut long-cut; do
  play refused-s --flow "$flow" --devices android-a --bots 2
  [ $? != 0 ] && grep -q "needs whole seconds, 1..$CUT_LINK_MAX_S" "$TMP/play.out" && [ ! -f "$TMP/node.args" ] \
    && ok "a cut-link marker with a bad duration is refused ($flow)" || ko "bad duration refused ($flow)" "$(cat "$TMP/play.out")"
done

# ── Two Android devices, each through its own proxy ──
play r-cut --flow cut --devices android-a,android-b --bots 2 --rounds 3
rc=$?
[ $rc = 0 ] && grep -q "RUN r-cut PASS" "$TMP/play.out" && ok "a cut-link run passes when every device cut its link" \
  || ko "cut-link run passes" "rc=$rc $(cat "$TMP/play.out")"
for pair in android-a:emulator-5554 android-b:emulator-5556; do
  label=${pair%%:*} serial=${pair#*:}
  port="$(ports_of r-cut .port "$label")"; control="$(ports_of r-cut .controlPort "$label")"
  [ -n "$port" ] && grep -qx "adb -s $serial reverse tcp:3000 tcp:$port" "$TMP/adb.log" \
    && ok "$label: adb reverse :3000 points at its own proxy (:$port)" || ko "$label: adb reverse to its proxy" "$(cat "$TMP/adb.log")"
  grep -qx "adb -s $serial shell am force-stop com.socketNull.ExposeMe" "$TMP/adb.log" \
    && ok "$label: the app is stopped, so no earlier connection bypasses the proxy" || ko "$label: app stopped"
  [ "$(maestro_env_of "$serial" LINK_CUT_URL)" = "http://127.0.0.1:$control/cut?seconds=2" ] \
    && ok "$label: its flow gets LINK_CUT_URL, its proxy's control with the header's seconds" \
    || ko "$label: LINK_CUT_URL" "$(cat "$TMP/maestro.args")"
  [ "$(grep "adb -s $serial reverse" "$TMP/adb.log" | tail -1)" = "adb -s $serial reverse tcp:3000 tcp:3000" ] \
    && ok "$label: adb reverse points straight at the server again when play ends" || ko "$label: reverse restored" "$(cat "$TMP/adb.log")"
  grep -q "$label: server link cut 1 time(s) for 2 s" "$TMP/play.out" \
    && ok "$label: play reports the cut its proxy logged" || ko "$label: cut reported" "$(cat "$TMP/play.out")"
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$control/status" \
    && ko "$label: its proxy is stopped when play ends" || ok "$label: its proxy is stopped when play ends"
done
[ "$(ports_of r-cut .port android-a)" != "$(ports_of r-cut .port android-b)" ] && ok "each device gets its own proxy port" \
  || ko "each device gets its own proxy port"
[ "$(grep -c '"cut":true' "$TMP/cut.replies")" = 2 ] && ok "both flows' POSTs cut their link" || ko "both POSTs cut" "$(cat "$TMP/cut.replies")"

# ── A proxy that can't start stops play before any bots or flow run (the 2nd device's: the 1st one's already up) ──
STUB_PROXY_FAIL=android-b LINK_PROXY_START_POLLS=3 play r-noproxy --flow cut --devices android-a,android-b --bots 2 --rounds 3
rc=$?
[ $rc != 0 ] && grep -q "android-b: its link proxy did not start" "$TMP/play.out" && [ ! -f "$TMP/maestro.args" ] \
  && [ ! -f "$TMP/node.args" ] && ok "a link proxy that can't start stops play before any flow or bots start" \
  || ko "proxy start failure stops play first" "rc=$rc maestro=$(cat "$TMP/maestro.args" 2>/dev/null) $(cat "$TMP/play.out")"
[ "$(grep "reverse" "$TMP/adb.log" | tail -1)" = "adb -s emulator-5554 reverse tcp:3000 tcp:3000" ] \
  && ok "the started device's reverse is restored when a later proxy fails" || ko "reverse restored on proxy failure" "$(cat "$TMP/adb.log")"

# ── A flow that never cut its link fails the run ──
STUB_NO_CUT=1 play r-nocut --flow cut --devices android-a --bots 2 --rounds 3
rc=$?
[ $rc != 0 ] && grep -q "android-a: LINK NEVER CUT" "$TMP/play.out" && ok "a device whose link was never cut fails the run" \
  || ko "never cut fails the run" "rc=$rc $(cat "$TMP/play.out")"
[ "$(grep "reverse" "$TMP/adb.log" | tail -1)" = "adb -s emulator-5554 reverse tcp:3000 tcp:3000" ] \
  && ok "the reverse is restored on a failed run too" || ko "reverse restored on failure" "$(cat "$TMP/adb.log")"

# ── The device-hosted room gets it too ──
play r-host --device-host --flow cut --devices android-a --bots 3
rc=$?
control="$(ports_of r-host .controlPort android-a)"
[ $rc = 0 ] && [ "$(maestro_env_of emulator-5554 LINK_CUT_URL)" = "http://127.0.0.1:$control/cut?seconds=2" ] \
  && grep -q "android-a: server link cut 1 time(s)" "$TMP/play.out" \
  && ok "--device-host: the hosting device's link goes through its proxy too" || ko "--device-host cut link" "rc=$rc $(cat "$TMP/play.out")"

# ── Flows without the marker keep the plain link ──
play r-plain --flow plain --devices android-a --bots 2 --rounds 3
rc=$?
[ $rc = 0 ] && [ ! -f "$TMP/adb.log" ] && ! grep -q LINK_CUT_URL "$TMP/maestro.args" && ! ls "$RUNS/r-plain"/link-* >/dev/null 2>&1 \
  && ok "a flow without the marker: no proxy, no adb reverse change, no LINK_CUT_URL" || ko "plain flow untouched" "rc=$rc $(cat "$TMP/play.out")"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
