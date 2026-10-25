#!/usr/bin/env bash
# ExposeMe device lab — boots iOS simulators + Android emulators, seeds photos,
# runs the local server/Metro, and drives multi-device games (Maestro + socket bots).
#
# Usage: qa/lab/lab.sh <command> [args]
#   doctor                      Check toolchain
#   setup                       One-time: install Maestro, create AVDs, npm deps for qa/
#   up [--ios N] [--android N]  Boot devices (default 2+2), grant perms, adb reverse, write devices.json
#   down                        Shut down all lab devices and background processes
#   status                      Show devices, server, metro
#   server [--restart] [--port N] [--stop]  Local Server on :3000 (log: qa/runs/server.log); --port for a worktree's own server
#   metro  [--restart]          Start Metro with EXPO_PUBLIC_SERVER_URL=http://localhost:3000
#   photos [N]                  Generate N labelled photos per device and push to its gallery (default 12)
#   build [ios|android|all]     Build dev-client binaries (slow, only when native deps change)
#   install                     Install the last built binaries on every lab device
#   open                        Open the app on every device, pointed at local Metro
#   shot <label>                Screenshot every device into qa/runs/<RUN_ID>/shots/<label>-<device>.png
#   play [--bots N] [--rounds R] [--devices all|pair|ios|android|none|<label,label>] [--flow play-game]
#                               Full multiplayer session: bots host a room, devices join and play
#   bots [args]                 Run qa/lab/bots.mjs directly (headless players / load / sync metrics)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QA="$ROOT/qa"
RUNS="$QA/runs"
STATE="$RUNS/.lab"
DEVICES_JSON="$STATE/devices.json"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
AVDMANAGER="$(ls -d "$SDK"/cmdline-tools/*/bin 2>/dev/null | head -1)/avdmanager"
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
APP_ID="com.socketNull.ExposeMe"
METRO_PORT=8081
SERVER_PORT=3000
DEV_CLIENT_URL="exp+expose-me://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}"
IOS_MODELS=("iPhone 17" "iPhone 16e" "iPhone 17 Pro Max" "iPad mini (A17 Pro)")
AVD_IMAGE="system-images;android-35;google_apis_playstore;arm64-v8a"
AVD_NAMES=("exposeme_a" "exposeme_b" "exposeme_c")
AVD_DEVICES=("pixel_7" "pixel_4" "pixel_tablet")

mkdir -p "$STATE"
# adb reads stdin and would swallow the device list of `devices | while read` loops
adbs() { "$ADB" -s "$@" </dev/null; }
log() { printf '\033[1;36m[lab]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[lab] %s\033[0m\n' "$*" >&2; exit 1; }
run_id() { echo "${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"; }
# Expo SDK 58 tooling needs an LTS Node (22.13+/24.3+, no odd releases): Client commands
# (Metro, native builds) use the newest nvm v24/v22 when the default node is unsupported.
client_path() {
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ $((major % 2)) -eq 1 ] || [ "$major" -lt 22 ]; then
    local bin; bin="$(ls -d "$HOME"/.nvm/versions/node/v2[24].*/bin 2>/dev/null | sort -V | tail -1)"
    [ -n "$bin" ] && { echo "$bin:$PATH"; return; }
  fi
  echo "$PATH"
}

ios_udid() { xcrun simctl list devices available -j | jq -r --arg n "$1" '[.devices[][] | select(.name==$n)][0].udid // empty'; }
emu_serial_for_avd() {
  for s in $("$ADB" devices | awk '/^emulator-/{print $1}'); do
    [ "$(adbs "$s" emu avd name 2>/dev/null | head -1 | tr -d '\r')" = "$1" ] && { echo "$s"; return 0; }
  done
  return 0
}
devices() { if [ -f "$DEVICES_JSON" ]; then jq -c '.[]' "$DEVICES_JSON"; fi; }

cmd_doctor() {
  local ok=1
  for t in xcrun jq node npm; do command -v $t >/dev/null || { echo "MISSING $t"; ok=0; }; done
  [ -x "$ADB" ] || { echo "MISSING adb ($ADB)"; ok=0; }
  [ -x "$EMULATOR" ] || { echo "MISSING emulator ($EMULATOR)"; ok=0; }
  [ -x "$MAESTRO" ] || { echo "MISSING maestro (run: qa/lab/lab.sh setup)"; ok=0; }
  [ -d "$QA/node_modules/socket.io-client" ] || { echo "MISSING qa deps (run: qa/lab/lab.sh setup)"; ok=0; }
  "$EMULATOR" -list-avds | grep -q exposeme_a || { echo "MISSING AVDs (run: qa/lab/lab.sh setup)"; ok=0; }
  java -version >/dev/null 2>&1 || { echo "MISSING java 17 (maestro + gradle)"; ok=0; }
  [ $ok = 1 ] && log "doctor: all good" || die "doctor: fix the items above"
}

cmd_setup() {
  if [ ! -x "$MAESTRO" ]; then
    log "Installing Maestro CLI into ~/.maestro"
    curl -fsSL "https://get.maestro.mobile.dev" | bash
  fi
  for i in 0 1; do
    if ! "$EMULATOR" -list-avds | grep -qx "${AVD_NAMES[$i]}"; then
      log "Creating AVD ${AVD_NAMES[$i]}"
      echo no | "$AVDMANAGER" create avd -n "${AVD_NAMES[$i]}" -k "$AVD_IMAGE" -d "${AVD_DEVICES[$i]}" --force
    fi
  done
  log "Installing qa/ node deps"
  (cd "$QA" && npm install --no-audit --no-fund)
  for p in Server Client; do
    [ -d "$ROOT/$p/node_modules" ] || (cd "$ROOT/$p" && npm install --no-audit --no-fund)
  done
  cmd_doctor
}

cmd_up() {
  local n_ios=2 n_android=2
  while [ $# -gt 0 ]; do case $1 in --ios) n_ios=$2; shift 2;; --android) n_android=$2; shift 2;; *) die "bad arg $1";; esac; done
  local list="[]" letters=(a b c d)
  for ((i=0; i<n_ios; i++)); do
    local name="${IOS_MODELS[$i]}" udid
    udid="$(ios_udid "$name")"; [ -n "$udid" ] || die "No simulator named '$name'"
    log "Booting iOS $name ($udid)"
    xcrun simctl boot "$udid" 2>/dev/null || true
    xcrun simctl privacy "$udid" grant photos "$APP_ID" 2>/dev/null || true
    list="$(jq -c --arg id "$udid" --arg l "ios-${letters[$i]}" --arg n "$name" '. + [{label:$l, platform:"ios", id:$id, model:$n}]' <<<"$list")"
  done
  open -a Simulator 2>/dev/null || open -b com.apple.iphonesimulator 2>/dev/null || true
  for ((i=0; i<n_android; i++)); do
    local avd="${AVD_NAMES[$i]}" serial
    serial="$(emu_serial_for_avd "$avd")"
    if [ -z "$serial" ]; then
      log "Starting Android emulator $avd"
      nohup "$EMULATOR" -avd "$avd" -no-snapshot-save -no-boot-anim -netdelay none -netspeed full >"$STATE/emu-$avd.log" 2>&1 &
      for _ in $(seq 1 90); do serial="$(emu_serial_for_avd "$avd")"; [ -n "$serial" ] && break; sleep 2; done
      [ -n "$serial" ] || die "Emulator $avd did not register with adb"
    fi
    adbs "$serial" wait-for-device
    until [ "$(adbs "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
    adbs "$serial" reverse tcp:$SERVER_PORT tcp:$SERVER_PORT
    adbs "$serial" reverse tcp:$METRO_PORT tcp:$METRO_PORT
    list="$(jq -c --arg id "$serial" --arg l "android-${letters[$i]}" --arg n "$avd" '. + [{label:$l, platform:"android", id:$id, model:$n}]' <<<"$list")"
    log "Android $avd ready on $serial (adb reverse :$SERVER_PORT :$METRO_PORT)"
  done
  echo "$list" | jq . >"$DEVICES_JSON"
  grant_android_perms
  log "Devices written to $DEVICES_JSON"; jq -r '.[] | "  \(.label)\t\(.platform)\t\(.id)\t\(.model)"' "$DEVICES_JSON"
}

grant_android_perms() {
  devices | while read -r d; do
    [ "$(jq -r .platform <<<"$d")" = android ] || continue
    local s; s="$(jq -r .id <<<"$d")"
    for p in READ_MEDIA_IMAGES READ_MEDIA_VISUAL_USER_SELECTED READ_EXTERNAL_STORAGE ACCESS_MEDIA_LOCATION; do
      adbs "$s" shell pm grant "$APP_ID" "android.permission.$p" >/dev/null 2>&1 || true
    done
  done
}

cmd_down() {
  devices | while read -r d; do
    local id; id="$(jq -r .id <<<"$d")"
    if [ "$(jq -r .platform <<<"$d")" = ios ]; then xcrun simctl shutdown "$id" 2>/dev/null || true
    else adbs "$id" emu kill 2>/dev/null || true; fi
  done
  bg_stop server $SERVER_PORT; bg_stop metro $METRO_PORT
  log "Lab down"
}

bg_start() { # name, logfile, cwd, cmd...
  local name=$1 logf=$2 cwd=$3; shift 3
  if [ -f "$STATE/$name.pid" ] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then log "$name already running"; return 0; fi
  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" </dev/null >"$logf" 2>&1 &
  echo $! >"$STATE/$name.pid"
  log "$name started (pid $!, log $logf)"
}
bg_stop() { # name, port
  if [ -f "$STATE/$1.pid" ]; then
    local pid; pid="$(cat "$STATE/$1.pid")"
    pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; rm -f "$STATE/$1.pid"
  fi
  lsof -ti "tcp:$2" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1; return 0
}

cmd_server() {
  # --port N runs a separate server (e.g. from a git worktree, for parallel fixers); --stop stops it
  local port=$SERVER_PORT restart=0 stop=0
  while [ $# -gt 0 ]; do case $1 in
    --restart) restart=1; shift;; --stop) stop=1; shift;; --port) port=$2; shift 2;; *) die "bad arg $1";; esac; done
  local name=server logf="$RUNS/server.log"
  [ "$port" != "$SERVER_PORT" ] && { name="server-$port"; logf="$RUNS/server-$port.log"; }
  if [ $stop = 1 ]; then bg_stop "$name" "$port"; log "$name stopped"; return 0; fi
  [ $restart = 1 ] && bg_stop "$name" "$port"
  # Bots/load tests upload from one IP: lift the per-IP /upload rate limit (override with UPLOAD_RATE_MAX=...)
  bg_start "$name" "$logf" "$ROOT/Server" env PORT="$port" UPLOAD_RATE_MAX="${UPLOAD_RATE_MAX:-100000}" npx ts-node server.ts
  for _ in $(seq 1 30); do curl -fs "http://localhost:$port/health" >/dev/null && { log "$name healthy on :$port"; return 0; }; sleep 1; done
  die "$name did not become healthy — see $logf"
}

cmd_metro() {
  [ "${1:-}" = --restart ] && bg_stop metro $METRO_PORT
  bg_start metro "$RUNS/metro.log" "$ROOT/Client" env PATH="$(client_path)" EXPO_PUBLIC_SERVER_URL="http://localhost:$SERVER_PORT" npx expo start --dev-client --port $METRO_PORT
  for _ in $(seq 1 60); do [[ "$(curl -fs "http://localhost:$METRO_PORT/status" 2>/dev/null)" == *running* ]] && { log "metro ready"; return 0; }; sleep 1; done
  die "metro not ready — see $RUNS/metro.log"
}

cmd_photos() {
  local n=${1:-12}
  devices | while read -r d; do
    local label id plat dir
    label="$(jq -r .label <<<"$d")"; id="$(jq -r .id <<<"$d")"; plat="$(jq -r .platform <<<"$d")"
    dir="$RUNS/photos/$label"; rm -rf "$dir"; mkdir -p "$dir"
    swift "$QA/lab/make-photos.swift" "$dir" "$label" "$n"
    if [ "$plat" = ios ]; then
      xcrun simctl addmedia "$id" "$dir"/*.jpg
    else
      adbs "$id" shell mkdir -p /sdcard/Pictures/ExposeMeQA
      adbs "$id" push "$dir"/. /sdcard/Pictures/ExposeMeQA/ >/dev/null
      adbs "$id" shell content call --method scan_volume --uri content://media --arg external_primary >/dev/null 2>&1 || true
    fi
    log "$label: $n photos pushed"
  done
  mkdir -p "$RUNS/photos/bots"; swift "$QA/lab/make-photos.swift" "$RUNS/photos/bots" "bot" "$n"
}

cmd_build() {
  local what=${1:-all} rc=0
  if [ "$what" = ios ] || [ "$what" = all ]; then
    log "Building iOS dev client with xcodebuild (slow, log: $RUNS/build-ios.log)"
    # expo run:ios needs Simulator.app to resolve devices; xcodebuild + simctl install does not
    # Every target (incl. pods declaring older minimums) builds at the app's prebuild deployment target
    (cd "$ROOT/Client/ios" && export PATH="$(client_path)" && { [ -d Pods ] || pod install; } \
      && dt="$(grep -m1 -o 'IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*' ExposeMe.xcodeproj/project.pbxproj | awk '{print $3}')" \
      && xcodebuild -workspace ExposeMe.xcworkspace -scheme ExposeMe \
      -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$ROOT/Client/ios/build" CODE_SIGNING_ALLOWED=NO IPHONEOS_DEPLOYMENT_TARGET="$dt" build) >"$RUNS/build-ios.log" 2>&1 \
      && echo "$ROOT/Client/ios/build/Build/Products/Debug-iphonesimulator/ExposeMe.app" >"$STATE/ios-app-path" \
      && log "iOS build OK" || { log "iOS build FAILED — tail $RUNS/build-ios.log"; rc=1; }
  fi
  if [ "$what" = android ] || [ "$what" = all ]; then
    log "Building Android dev client (slow, log: $RUNS/build-android.log)"
    (cd "$ROOT/Client/android" && PATH="$(client_path)" ./gradlew :app:assembleDebug) >"$RUNS/build-android.log" 2>&1 \
      && echo "$ROOT/Client/android/app/build/outputs/apk/debug/app-debug.apk" >"$STATE/android-apk-path" \
      && log "Android build OK" || { log "Android build FAILED — tail $RUNS/build-android.log"; rc=1; }
  fi
  cmd_install
  return $rc
}

cmd_install() {
  local app apk; app="$(cat "$STATE/ios-app-path" 2>/dev/null || true)"; apk="$(cat "$STATE/android-apk-path" 2>/dev/null || true)"
  devices | while read -r d; do
    local id; id="$(jq -r .id <<<"$d")"
    if [ "$(jq -r .platform <<<"$d")" = ios ]; then
      [ -d "$app" ] && xcrun simctl install "$id" "$app" && xcrun simctl privacy "$id" grant photos "$APP_ID" || true
    else
      [ -f "$apk" ] && adbs "$id" install -r -g "$apk" >/dev/null || true
    fi
    log "installed on $(jq -r .label <<<"$d")"
  done
  grant_android_perms
}

cmd_open() {
  devices | while read -r d; do
    local id; id="$(jq -r .id <<<"$d")"
    if [ "$(jq -r .platform <<<"$d")" = ios ]; then xcrun simctl openurl "$id" "$DEV_CLIENT_URL"
    else adbs "$id" shell am start -a android.intent.action.VIEW -d "'$DEV_CLIENT_URL'" >/dev/null; fi
  done
  log "app opened on all devices"
}

cmd_shot() {
  local label=${1:-snap} dir="$RUNS/$(run_id)/shots"; mkdir -p "$dir"
  devices | while read -r d; do
    local id dl; id="$(jq -r .id <<<"$d")"; dl="$(jq -r .label <<<"$d")"
    if [ "$(jq -r .platform <<<"$d")" = ios ]; then xcrun simctl io "$id" screenshot "$dir/$label-$dl.png" >/dev/null 2>&1
    else adbs "$id" exec-out screencap -p >"$dir/$label-$dl.png"; fi
  done
  log "screenshots in $dir"
}

cmd_play() {
  local bots=3 rounds=10 which=all flow=play-game
  while [ $# -gt 0 ]; do case $1 in
    --bots) bots=$2; shift 2;; --rounds) rounds=$2; shift 2;; --devices) which=$2; shift 2;; --flow) flow=$2; shift 2;;
    *) die "bad arg $1";; esac; done
  export RUN_ID; RUN_ID="$(run_id)"; local dir="$RUNS/$RUN_ID"; mkdir -p "$dir/maestro"
  local sel='.'; [ "$which" = ios ] && sel='select(.platform=="ios")'; [ "$which" = android ] && sel='select(.platform=="android")'
  [ "$which" = none ] && sel='select(false)'
  # pair = first iOS + first Android (default for per-fix checks); a,b = explicit labels
  if [ "$which" = pair ]; then
    which="$(jq -r '[(map(select(.platform=="ios"))[0].label), (map(select(.platform=="android"))[0].label)] | map(select(. != null)) | join(",")' "$DEVICES_JSON")"
  fi
  case $which in all|ios|android|none) ;; *)
    sel="select(.label as \$l | \"$which\" | split(\",\") | index(\$l))";; esac
  local n_dev; n_dev="$(devices | jq -c "$sel" | wc -l | tr -d ' ')"
  local total=$((bots + n_dev))
  [ "$total" -ge 2 ] || die "need at least 2 players"
  log "RUN $RUN_ID: $bots bots + $n_dev devices, $rounds rounds"
  node "$QA/lab/bots.mjs" --bots "$bots" --host --rounds "$rounds" --wait-players "$total" \
    --photos "$RUNS/photos/bots" --out "$dir/bots.json" --code-file "$dir/code" >"$dir/bots.log" 2>&1 &
  local bots_pid=$!
  for _ in $(seq 1 30); do [ -s "$dir/code" ] && break; sleep 1; done
  [ -s "$dir/code" ] || { kill $bots_pid 2>/dev/null; die "bots did not create a room — see $dir/bots.log"; }
  local code; code="$(cat "$dir/code")"; log "room $code"
  local pids=()
  while read -r d; do
    [ -n "$d" ] || continue
    local id dl; id="$(jq -r .id <<<"$d")"; dl="$(jq -r .label <<<"$d")"
    "$MAESTRO" --device "$id" test "$QA/maestro/$flow.yaml" \
      -e GAME_CODE="$code" -e USERNAME="$dl" -e METRO_URL="http%3A%2F%2Flocalhost%3A$METRO_PORT" \
      --test-output-dir "$dir/maestro/$dl" --format junit --output "$dir/maestro/$dl.xml" >"$dir/maestro/$dl.log" 2>&1 &
    pids+=($!)
  done < <(devices | jq -c "$sel")
  local fail=0
  for p in "${pids[@]:-}"; do [ -n "$p" ] && { wait "$p" || fail=1; }; done
  wait $bots_pid || fail=1
  node -e 'const r=require(process.argv[1]);console.log(JSON.stringify(r.summary,null,2))' "$dir/bots.json" 2>/dev/null || true
  [ $fail = 0 ] && log "RUN $RUN_ID PASS ($dir)" || { log "RUN $RUN_ID had failures ($dir)"; exit 1; }
}

cmd_status() {
  log "devices:"; [ -f "$DEVICES_JSON" ] && jq -r '.[] | "  \(.label)\t\(.id)\t\(.model)"' "$DEVICES_JSON" || echo "  (none — run up)"
  for s in server metro; do
    if [ -f "$STATE/$s.pid" ] && kill -0 "$(cat "$STATE/$s.pid")" 2>/dev/null; then log "$s: running"; else log "$s: stopped"; fi
  done
}

c=${1:-help}; shift || true
case $c in
  doctor|setup|up|down|status|server|metro|photos|build|install|open|shot|play) "cmd_$c" "$@";;
  bots) node "$QA/lab/bots.mjs" "$@";;
  *) sed -n '2,24p' "$0";;
esac
