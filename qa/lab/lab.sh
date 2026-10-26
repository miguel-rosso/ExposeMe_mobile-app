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
#                               QA render telemetry on: qa-ack lines in qa/runs/telemetry.jsonl (telemetry-<port>.jsonl)
#   metro  [--restart]          Start Metro with EXPO_PUBLIC_SERVER_URL=http://localhost:3000 and EXPO_PUBLIC_QA=1
#   photos [N] [--reset]        Seed N labelled photos per device gallery (default 12); idempotent: replaces the
#                               lab's own photos, never stacks copies (--reset: wipe lab photos / iOS photo library first)
#   build [ios|android|all]     Build dev-client binaries (slow, only when native deps change)
#   install                     Install the last built binaries on every lab device (non-zero if any install failed)
#   open                        Open the app on every device, pointed at local Metro
#   shot <label>                Screenshot every device into qa/runs/<RUN_ID>/shots/<label>-<device>.png
#   play [--bots N] [--rounds R] [--devices all|pair|ios|android|none|<label,label>] [--flow play-game] [--bot-args "..."]
#                               Full multiplayer session: bots host a room, devices join and play; prints the bots
#                               summary and the device render skew per phase (qa/runs/<RUN_ID>/render-skew.json)
#                               (--bot-args: extra bots.mjs flags, e.g. --flow tie-game --bot-args --no-answer)
#        [--second-room "<bots.mjs args>"]  also start a 2nd bots room; its code reaches the flows as NEW_CODE
#        [--maestro-env KEY=VALUE]          extra Maestro variable for every device (repeatable)
#        [--server http://localhost:P | --port P]  bots and render telemetry use that lab server (e.g. a worktree's
#                                           own: server --port P); devices and Metro always stay on :3000
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
warn() { printf '\033[1;33m[lab] %s\033[0m\n' "$*" >&2; }
run_id() { echo "${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"; }
# ── Toolchain checks (sourceable: qa/lab/tests/lab-functions.test.sh) ──
# Client commands (Metro, native builds) must run on the Node major pinned in Client/.nvmrc.
# Uses the default node when it matches, else the newest matching nvm/Homebrew install;
# fails loudly (non-zero + message on stderr) when none is found.
client_node_major() { # prints the major version pinned in Client/.nvmrc ("24", "v24.3.0" → 24)
  local f="$ROOT/Client/.nvmrc" v
  [ -f "$f" ] || { echo "[lab] missing $f" >&2; return 1; }
  v="$(tr -d ' \r\n' <"$f")"; v="${v#v}"; v="${v%%.*}"
  [[ "$v" =~ ^[0-9]+$ ]] || { echo "[lab] cannot parse a Node major from $f ('$(cat "$f")')" >&2; return 1; }
  echo "$v"
}
client_path() {
  local want cur bin
  want="$(client_node_major)" || return 1
  cur="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$cur" = "$want" ] && { echo "$PATH"; return 0; }
  bin="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin 2>/dev/null | sort -V | tail -1)"
  # LAB_BREW_PREFIXES: space-separated Homebrew prefixes to search (overridable for tests)
  [ -n "$bin" ] || for p in ${LAB_BREW_PREFIXES:-${HOMEBREW_PREFIX:-/opt/homebrew} /usr/local}; do
    [ -x "$p/opt/node@$want/bin/node" ] && { bin="$p/opt/node@$want/bin"; break; }
  done
  if [ -z "$bin" ] || [ ! -x "$bin/node" ]; then
    printf '\033[1;31m[lab] Client needs Node %s (Client/.nvmrc) but found node %s and no v%s install in nvm or Homebrew. Run: nvm install %s\033[0m\n' \
      "$want" "$cur" "$want" "$want" >&2
    return 1
  fi
  echo "$bin:$PATH"
}
# Pods need `pod install` when missing, when Podfile.lock and Pods/Manifest.lock differ, or when the
# Podfile or the npm deps changed after the last install (autolinking only picks up new native
# modules such as expo-image-manipulator during pod install, so Podfile.lock alone lags behind)
pods_stale() { # ios dir (its parent is the Client dir); exit 0 = pod install needed
  local d=$1 m="$1/Pods/Manifest.lock" f
  [ -f "$d/Podfile.lock" ] && [ -f "$m" ] || return 0
  cmp -s "$d/Podfile.lock" "$m" || return 0
  for f in "$d/Podfile" "$d/Podfile.properties.json" "$d/../package.json" "$d/../package-lock.json"; do
    [ "$f" -nt "$m" ] && return 0
  done
  return 1
}
# pod install leaves Manifest.lock untouched when its content is unchanged: bump its mtime so
# inputs that changed without affecting pods (JS-only deps, rewritten Podfile) stop triggering it
pods_mark_installed() { touch "$1/Pods/Manifest.lock"; }

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
  client_path >/dev/null || ok=0
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
  # Show the simulators: Xcode 27 replaced Simulator.app with DeviceHub
  [ "$n_ios" -gt 0 ] && { open -g -b com.apple.dt.Devices 2>/dev/null || open -g -a Simulator 2>/dev/null || true; }
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

bg_running() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; } # name
bg_start() { # name, logfile, cwd, cmd...
  local name=$1 logf=$2 cwd=$3; shift 3
  if bg_running "$name"; then log "$name already running"; return 0; fi
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
  local name=server logf="$RUNS/server.log" telemetry; telemetry="$(telemetry_file "$port")"
  [ "$port" != "$SERVER_PORT" ] && { name="server-$port"; logf="$RUNS/server-$port.log"; }
  if [ $stop = 1 ]; then bg_stop "$name" "$port"; log "$name stopped"; return 0; fi
  [ $restart = 1 ] && bg_stop "$name" "$port"
  # Bots/load tests: lift the per-player and per-room /upload rate limits, the /upload in-flight caps and the per-IP
  # socket limits (every bot shares one IP) (override with UPLOAD_PLAYER_RATE_MAX=... / UPLOAD_ROOM_RATE_MAX=... /
  # UPLOAD_INFLIGHT_*=... / SOCKET_MAX_CONNECTIONS_PER_IP=... / JOIN_MISS_MAX=... / JOIN_MISS_PREFIX_MAX=... /
  # JOIN_MISS_GLOBAL_MAX=... / JOIN_MISS_PRESSURE_MAX=...).
  # ALLOW_QA_ROUNDS=1: accept QA-only 3-round games (play --rounds 3); production never sets it
  # QA_TELEMETRY=1: record the qa-ack of QA builds (when each device rendered a phase) in $telemetry (play reads it);
  # a fresh server starts a fresh file, so it never grows across sessions
  bg_running "$name" || rotate_telemetry "$telemetry"
  bg_start "$name" "$logf" "$ROOT/Server" env PORT="$port" ALLOW_QA_ROUNDS=1 QA_TELEMETRY=1 QA_TELEMETRY_FILE="$telemetry" \
    UPLOAD_ROOM_RATE_MAX="${UPLOAD_ROOM_RATE_MAX:-100000}" \
    UPLOAD_PLAYER_RATE_MAX="${UPLOAD_PLAYER_RATE_MAX:-100000}" \
    UPLOAD_INFLIGHT_MAX="${UPLOAD_INFLIGHT_MAX:-10000}" UPLOAD_INFLIGHT_PER_IP_MAX="${UPLOAD_INFLIGHT_PER_IP_MAX:-10000}" \
    UPLOAD_INFLIGHT_PER_ROOM_MAX="${UPLOAD_INFLIGHT_PER_ROOM_MAX:-10000}" UPLOAD_INFLIGHT_PER_MEMBER_MAX="${UPLOAD_INFLIGHT_PER_MEMBER_MAX:-10000}" \
    SOCKET_MAX_CONNECTIONS_PER_IP="${SOCKET_MAX_CONNECTIONS_PER_IP:-100000}" \
    JOIN_MISS_MAX="${JOIN_MISS_MAX:-100000}" JOIN_MISS_PREFIX_MAX="${JOIN_MISS_PREFIX_MAX:-1000000}" \
    JOIN_MISS_GLOBAL_MAX="${JOIN_MISS_GLOBAL_MAX:-10000000}" JOIN_MISS_PRESSURE_MAX="${JOIN_MISS_PRESSURE_MAX:-100000}" \
    npx ts-node server.ts
  for _ in $(seq 1 30); do curl -fs "http://localhost:$port/health" >/dev/null && { log "$name healthy on :$port"; return 0; }; sleep 1; done
  die "$name did not become healthy — see $logf"
}

cmd_metro() {
  [ "${1:-}" = --restart ] && bg_stop metro $METRO_PORT
  local cpath; cpath="$(client_path)" || exit 1
  bg_start metro "$RUNS/metro.log" "$ROOT/Client" env PATH="$cpath" EXPO_PUBLIC_SERVER_URL="http://localhost:$SERVER_PORT" \
    EXPO_PUBLIC_QA=1 npx expo start --dev-client --port $METRO_PORT
  for _ in $(seq 1 60); do [[ "$(curl -fs "http://localhost:$METRO_PORT/status" 2>/dev/null)" == *running* ]] && { log "metro ready"; return 0; }; sleep 1; done
  die "metro not ready — see $RUNS/metro.log"
}

# ── Gallery seeding (sourceable: qa/lab/tests/lab-photos.test.sh) ──
# `photos` is idempotent: re-running it never stacks a second copy of the labelled photos.
#  - Android: every lab file is named exposeme-lab-<label>-NN.jpg inside the lab-only folder
#    ANDROID_PHOTO_DIR; its old *.jpg files are deleted before the push and the media rescan drops
#    them from MediaStore. Media outside that folder is never touched.
#  - iOS: `simctl addmedia` can't delete and renames imports to IMG_NNNN, so after seeding the lab
#    writes a marker ("<label> <count>") into the simulator's Media folder and later only adds the
#    photos the gallery is missing. The marker lives next to the photo library, so erasing the
#    simulator forgets it too. Photos deleted by hand leave the marker stale: use --reset.
#  - --reset: Android deletes the whole lab folder; iOS shuts the simulator down, deletes its photo
#    library (Media/DCIM + Media/PhotoData: ALL photos on that simulator) and boots it again.
LAB_PHOTO_PREFIX="exposeme-lab-"
ANDROID_PHOTO_DIR="/sdcard/Pictures/ExposeMeQA"
IOS_PHOTO_MARKER="${LAB_PHOTO_PREFIX}seeded"
SIM_DEVICES_DIR="${SIM_DEVICES_DIR:-$HOME/Library/Developer/CoreSimulator/Devices}"
DEFAULT_PHOTO_COUNT=12

parse_photos_args() { # [N] [--reset] -> sets PHOTOS_N and PHOTOS_RESET (0|1); returns 1 on a bad argument
  PHOTOS_N=$DEFAULT_PHOTO_COUNT PHOTOS_RESET=0
  while [ $# -gt 0 ]; do
    case $1 in
      --reset) PHOTOS_RESET=1;;
      *) [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo "[lab] photos: bad argument '$1' (usage: photos [N] [--reset])" >&2; return 1; }
         PHOTOS_N=$1;;
    esac
    shift
  done
}
generate_lab_photos() { # dir, label, count: fresh labelled photos, no leftovers from an older run
  rm -rf "$1"; mkdir -p "$1"
  swift "$QA/lab/make-photos.swift" "$1" "$2" "$3" "$LAB_PHOTO_PREFIX"
}
lab_photos_from() { # dir, first index: the generated photos numbered >= first index, in order
  local f i
  for f in "$1/$LAB_PHOTO_PREFIX"*.jpg; do
    [ -e "$f" ] || continue
    i="${f##*-}"; i="${i%.jpg}"
    [ $((10#$i)) -ge "$2" ] && echo "$f"
  done
  return 0
}

# ── Android ──
android_seed_photos() { # serial, dir, reset (0|1), [label for the log, default the serial]
  local serial=$1 dir=$2 reset=$3 label=${4:-$1}
  # The folder is lab-only, so every *.jpg in it is a lab photo (also those named before the
  # exposeme-lab- prefix). adb runs the command through the device shell: the quoted * expands there
  if [ "$reset" = 1 ]; then
    adbs "$serial" shell rm -rf "$ANDROID_PHOTO_DIR"
    log "$label: --reset: deleted the lab folder $ANDROID_PHOTO_DIR"
  else adbs "$serial" shell rm -f "$ANDROID_PHOTO_DIR/*.jpg"; fi
  adbs "$serial" shell mkdir -p "$ANDROID_PHOTO_DIR"
  adbs "$serial" push "$dir"/. "$ANDROID_PHOTO_DIR/" >/dev/null
  # The rescan also prunes the deleted files from MediaStore, so the gallery never lists them twice
  adbs "$serial" shell content call --method scan_volume --uri content://media --arg external_primary >/dev/null 2>&1 || true
}

# ── iOS ──
ios_media_dir() { echo "$SIM_DEVICES_DIR/$1/data/Media"; } # udid
ios_photo_plan() { # seeded label, seeded count, label, count -> "add <first index>" | "skip <reason>"
  local seeded_label=$1 seeded_n=$2 label=$3 n=$4
  if [ -z "$seeded_label" ]; then echo "add 1"
  elif [ "$seeded_label" != "$label" ]; then echo "skip gallery holds $seeded_label photos (run: photos --reset)"
  elif [ "$seeded_n" -gt "$n" ]; then echo "skip already has $seeded_n photos, more than $n (run: photos --reset to shrink)"
  elif [ "$seeded_n" -eq "$n" ]; then echo "skip already has $n photos"
  else echo "add $((seeded_n + 1))"
  fi
}
is_sim_udid() { [[ "$1" =~ ^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$ ]]; }
# Guards every path built from a udid: a real simulator UUID whose folder holds a device.plist
# (never "booted", "../x" or a missing simulator, so the deletes below can't leave its folder)
check_sim_dir() { # udid
  is_sim_udid "$1" || { echo "'$1' is not a simulator UUID"; return 1; }
  [ -f "$SIM_DEVICES_DIR/$1/device.plist" ] || { echo "no simulator at $SIM_DEVICES_DIR/$1"; return 1; }
}
# These run inside $(...) where errexit is off: every step checks its own status and they print
# the reason on failure so cmd_photos can report it (progress lines go to stderr, outside the captured reason)
ios_reset_photos() { # udid, [label for the log, default the udid]: wipes the simulator's whole photo library (shutdown -> delete -> boot)
  local udid=$1 label=${2:-$1} media
  check_sim_dir "$udid" || return 1
  media="$(ios_media_dir "$udid")"
  log "$label: --reset: shutting down the simulator to delete its whole photo library" >&2
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  rm -rf "$media/DCIM" "$media/PhotoData" "$media/$IOS_PHOTO_MARKER" || { echo "could not delete the photo library in $media"; return 1; }
  log "$label: --reset: photo library deleted, rebooting the simulator" >&2
  xcrun simctl boot "$udid" || { echo "simctl boot failed after the reset"; return 1; }
  xcrun simctl bootstatus "$udid" -b >/dev/null || { echo "simulator did not finish booting after the reset"; return 1; }
  log "$label: --reset: simulator rebooted with an empty photo library" >&2
}
ios_seed_photos() { # udid, dir, label, count, reset (0|1); prints what it did, or why it failed (non-zero)
  local udid=$1 dir=$2 label=$3 n=$4 reset=$5 marker seeded_label="" seeded_n=0 plan first f files=()
  check_sim_dir "$udid" || return 1
  marker="$(ios_media_dir "$udid")/$IOS_PHOTO_MARKER"
  if [ "$reset" = 1 ]; then ios_reset_photos "$udid" "$label" || return 1; fi
  [ -f "$marker" ] && read -r seeded_label seeded_n <"$marker"
  plan="$(ios_photo_plan "$seeded_label" "${seeded_n:-0}" "$label" "$n")"
  [ "${plan%% *}" = skip ] && { echo "${plan#skip }"; return 0; }
  first="${plan#add }"
  generate_lab_photos "$dir" "$label" "$n" >/dev/null || { echo "make-photos.swift failed"; return 1; }
  while read -r f; do files+=("$f"); done < <(lab_photos_from "$dir" "$first")
  [ ${#files[@]} -gt 0 ] || { echo "no generated photos from #$first in $dir"; return 1; }
  xcrun simctl addmedia "$udid" "${files[@]}" || { echo "simctl addmedia failed (gallery not marked as seeded)"; return 1; }
  mkdir -p "${marker%/*}" && echo "$label $n" >"$marker" || { echo "could not write $marker"; return 1; }
  echo "added photos #$first-#$n"
}

cmd_photos() {
  parse_photos_args "$@" || exit 1
  local n=$PHOTOS_N reset=$PHOTOS_RESET
  devices | while read -r d; do
    local label id plat dir out
    label="$(jq -r .label <<<"$d")"; id="$(jq -r .id <<<"$d")"; plat="$(jq -r .platform <<<"$d")"
    dir="$RUNS/photos/$label"
    if [ "$plat" = ios ]; then
      out="$(ios_seed_photos "$id" "$dir" "$label" "$n" "$reset")" || die "$label: $out"
      log "$label: $out"
    else
      generate_lab_photos "$dir" "$label" "$n" >/dev/null
      android_seed_photos "$id" "$dir" "$reset" "$label"
      log "$label: $n photos (previous lab photos replaced)"
    fi
  done || exit 1   # a device that failed (die in the pipeline's subshell) stops the command
  generate_lab_photos "$RUNS/photos/bots" "bot" "$n"
}

cmd_build() {
  local what=${1:-all} rc=0 cpath
  cpath="$(client_path)" || exit 1
  if [ "$what" = ios ] || [ "$what" = all ]; then
    log "Building iOS dev client with xcodebuild (slow, log: $RUNS/build-ios.log)"
    pods_stale "$ROOT/Client/ios" && log "Pods missing or out of sync with Podfile.lock: running pod install"
    # expo run:ios needs Simulator.app to resolve devices; xcodebuild + simctl install does not
    # Every target (incl. pods declaring older minimums) builds at the app's prebuild deployment target
    (cd "$ROOT/Client/ios" && export PATH="$cpath" && { ! pods_stale . || { pod install && pods_mark_installed .; }; } \
      && dt="$(grep -m1 -o 'IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*' ExposeMe.xcodeproj/project.pbxproj | awk '{print $3}')" \
      && xcodebuild -workspace ExposeMe.xcworkspace -scheme ExposeMe \
      -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
      -derivedDataPath "$ROOT/Client/ios/build" CODE_SIGNING_ALLOWED=NO IPHONEOS_DEPLOYMENT_TARGET="$dt" build) >"$RUNS/build-ios.log" 2>&1 \
      && echo "$ROOT/Client/ios/build/Build/Products/Debug-iphonesimulator/ExposeMe.app" >"$STATE/ios-app-path" \
      && log "iOS build OK" || { log "iOS build FAILED — tail $RUNS/build-ios.log"; rc=1; }
  fi
  if [ "$what" = android ] || [ "$what" = all ]; then
    log "Building Android dev client (slow, log: $RUNS/build-android.log)"
    (cd "$ROOT/Client/android" && PATH="$cpath" ./gradlew :app:assembleDebug) >"$RUNS/build-android.log" 2>&1 \
      && echo "$ROOT/Client/android/app/build/outputs/apk/debug/app-debug.apk" >"$STATE/android-apk-path" \
      && log "Android build OK" || { log "Android build FAILED — tail $RUNS/build-android.log"; rc=1; }
  fi
  cmd_install
  return $rc
}

# ── Install (sourceable: qa/lab/tests/lab-functions.test.sh) ──
# One device: 0 installed, or skipped because its platform has no build yet; 1 the install command failed
install_on_device() { # device json, iOS .app path, Android .apk path
  local d=$1 app=$2 apk=$3 id label
  id="$(jq -r .id <<<"$d")"; label="$(jq -r .label <<<"$d")"
  if [ "$(jq -r .platform <<<"$d")" = ios ]; then
    [ -n "$app" ] && [ -d "$app" ] || { warn "$label: skipped, no iOS build (run: lab.sh build ios)"; return 0; }
    xcrun simctl install "$id" "$app" || { warn "$label: simctl install FAILED"; return 1; }
    xcrun simctl privacy "$id" grant photos "$APP_ID" 2>/dev/null || true
  else
    [ -n "$apk" ] && [ -f "$apk" ] || { warn "$label: skipped, no Android build (run: lab.sh build android)"; return 0; }
    adbs "$id" install -r -g "$apk" >/dev/null || { warn "$label: adb install FAILED"; return 1; }
  fi
  log "installed on $label"
}

cmd_install() { # tries every device, then exits non-zero naming those whose install failed
  local app apk d failed=()
  app="$(cat "$STATE/ios-app-path" 2>/dev/null || true)"; apk="$(cat "$STATE/android-apk-path" 2>/dev/null || true)"
  while read -r d; do
    install_on_device "$d" "$app" "$apk" || failed+=("$(jq -r .label <<<"$d")")
  done < <(devices)
  grant_android_perms
  [ ${#failed[@]} = 0 ] || die "install failed on: ${failed[*]}"
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

# ── QA render telemetry (sourceable: qa/lab/tests/render-skew.test.sh) ──
telemetry_file() { # port: the JSON-lines file where that lab server records qa-ack (Server/GAME_FLOW.md)
  if [ "${1:-$SERVER_PORT}" = "$SERVER_PORT" ]; then echo "$RUNS/telemetry.jsonl"; else echo "$RUNS/telemetry-$1.jsonl"; fi
}

rotate_telemetry() { # file: keep only the previous server session's telemetry (file.prev), start the new one empty
  if [ -f "$1" ]; then mv -f "$1" "$1.prev"; fi
  return 0
}

print_render_skew() { # dir, room code, [server port]: per-phase render skew of that room (QA builds only) -> dir/render-skew.json
  local file; file="$(telemetry_file "${3:-$SERVER_PORT}")"
  [ -s "$file" ] || return 0
  log "device render skew (ms, spread of qa-ack receipt across devices):"
  node "$QA/lab/render-skew.mjs" "$file" "$2" | tee "$1/render-skew.json" || true
}

# ── play helpers (sourceable: qa/lab/tests/lab-play.test.sh) ──
ROOM_CODE_TIMEOUT_S=30          # how long a bots room may take to publish its code (override: LAB_ROOM_CODE_TIMEOUT)
MAESTRO_ENV_RE='^[A-Za-z_][A-Za-z0-9_]*='
PORT_RE='^[1-9][0-9]{0,4}$'
MAX_PORT=65535
LAB_SERVER_URL_RE='^http://(localhost|127\.0\.0\.1):([1-9][0-9]{0,4})/?$'
# A server picked inside the free-form bots.mjs flags would win over play's own (bots.mjs keeps the last --server)
BOTS_SERVER_OVERRIDE_RE='(^|[[:space:]])--server([[:space:]=]|$)|SERVER_URL='
PLAY_BG_PIDS=()                 # bots.mjs processes started by the current play, stopped on exit

stop_play_bots() { # a bots room that already exited is fine (kill fails, set -e must not abort)
  local p; for p in "${PLAY_BG_PIDS[@]:-}"; do [ -z "$p" ] || kill "$p" 2>/dev/null || true; done; PLAY_BG_PIDS=()
}

forget_bots_pid() { # pid: drop a reaped bots process so a reused PID is never signalled
  local p kept=(); for p in "${PLAY_BG_PIDS[@]:-}"; do [ -z "$p" ] || [ "$p" = "$1" ] || kept+=("$p"); done
  PLAY_BG_PIDS=(${kept[@]+"${kept[@]}"})
}

start_bots_room() { # dir, server url, bots.mjs args...: runs bots.mjs in the background → dir/{code,bots.json,bots.log}; sets BOTS_PID
  local dir=$1 server=$2; shift 2; mkdir -p "$dir"
  node "$QA/lab/bots.mjs" --server "$server" --photos "$RUNS/photos/bots" --out "$dir/bots.json" --code-file "$dir/code" "$@" \
    >"$dir/bots.log" 2>&1 &
  BOTS_PID=$!; PLAY_BG_PIDS+=("$BOTS_PID")
}

# play only drives local lab servers (lab.sh server [--port P]): their telemetry file is known, and QA traffic
# never reaches production
lab_server_port() { # --server URL | --port P: prints the port of that local lab server; returns 1 for anything else
  local port
  case $1 in
    --server) [[ ${2:-} =~ $LAB_SERVER_URL_RE ]] || return 1; port=${BASH_REMATCH[2]};;
    --port) [[ ${2:-} =~ $PORT_RE ]] || return 1; port=$2;;
    *) return 1;;
  esac
  [ "$port" -le "$MAX_PORT" ] && echo "$port"
}

reject_bots_server_override() { # play option, its bots.mjs flags: dies if they pick a server themselves
  [[ ! $2 =~ $BOTS_SERVER_OVERRIDE_RE ]] \
    || die "$1 can't choose the bots' server (got '$2'): use play's own --server http://localhost:PORT or --port PORT"
}

wait_room_code() { # dir, label: prints the room code the bots wrote to dir/code, or dies
  local dir=$1 label=$2 i
  for ((i = 0; i < ${LAB_ROOM_CODE_TIMEOUT:-$ROOM_CODE_TIMEOUT_S}; i++)); do [ -s "$dir/code" ] && break; sleep 1; done
  [ -s "$dir/code" ] || die "$label did not create a room — see $dir/bots.log"
  cat "$dir/code"
}

cmd_play() {
  local bots=3 rounds=10 which=all flow=play-game bot_args="" second_room="" maestro_env=() server_port=$SERVER_PORT
  while [ $# -gt 0 ]; do case $1 in
    --bots) bots=$2; shift 2;; --rounds) rounds=$2; shift 2;; --devices) which=$2; shift 2;; --flow) flow=$2; shift 2;;
    --bot-args) bot_args=$2; shift 2;;
    --second-room) [ $# -ge 2 ] || die "--second-room needs the bots.mjs args of the 2nd room"; second_room=$2; shift 2;;
    --maestro-env) [[ ${2:-} =~ $MAESTRO_ENV_RE ]] || die "--maestro-env needs KEY=VALUE (got '${2:-}')"
      maestro_env+=(-e "$2"); shift 2;;
    --server|--port) server_port="$(lab_server_port "$1" "${2:-}")" \
      || die "$1 needs a local lab server: --server http://localhost:PORT or --port PORT (got '${2:-}')"; shift 2;;
    *) die "bad arg $1";; esac; done
  reject_bots_server_override --bot-args "$bot_args"
  reject_bots_server_override --second-room "$second_room"
  local server_url="http://localhost:$server_port"
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
  log "RUN $RUN_ID: $bots bots + $n_dev devices, $rounds rounds, server $server_url"
  if [ "$server_port" != "$SERVER_PORT" ] && [ "$n_dev" -gt 0 ]; then
    warn "devices and Metro always use the shared server :$SERVER_PORT, so they can't join a room on :$server_port" \
      "(their flows will fail); use --devices none to play bots only against your own server"
  fi
  trap stop_play_bots EXIT
  # Optional 2nd room (e.g. the invite target of invite-link-after-game): its code reaches the flows as NEW_CODE.
  # It is auxiliary: it is stopped once the main run ends and its exit status does not count.
  if [ -n "$second_room" ]; then
    # shellcheck disable=SC2086 # second_room is a list of bots.mjs flags
    start_bots_room "$dir/second-room" "$server_url" $second_room
    local new_code; new_code="$(wait_room_code "$dir/second-room" "second room")" || exit 1
    log "second room $new_code"; maestro_env+=(-e "NEW_CODE=$new_code")
  fi
  # shellcheck disable=SC2086 # bot_args is a list of bots.mjs flags
  start_bots_room "$dir" "$server_url" --bots "$bots" --host --rounds "$rounds" --wait-players "$total" $bot_args
  local bots_pid=$BOTS_PID
  local code; code="$(wait_room_code "$dir" "bots")" || exit 1
  log "room $code"
  local pids=()
  while read -r d; do
    [ -n "$d" ] || continue
    local id dl; id="$(jq -r .id <<<"$d")"; dl="$(jq -r .label <<<"$d")"
    "$MAESTRO" --device "$id" test "$QA/maestro/$flow.yaml" \
      -e GAME_CODE="$code" -e USERNAME="$dl" -e METRO_URL="http%3A%2F%2Flocalhost%3A$METRO_PORT" \
      ${maestro_env[@]+"${maestro_env[@]}"} \
      --test-output-dir "$dir/maestro/$dl" --format junit --output "$dir/maestro/$dl.xml" >"$dir/maestro/$dl.log" 2>&1 &
    pids+=($!)
  done < <(devices | jq -c "$sel")
  local fail=0
  for p in "${pids[@]:-}"; do [ -n "$p" ] && { wait "$p" || fail=1; }; done
  wait $bots_pid || fail=1
  forget_bots_pid "$bots_pid"
  stop_play_bots
  node -e 'const r=require(process.argv[1]);console.log(JSON.stringify(r.summary,null,2))' "$dir/bots.json" 2>/dev/null || true
  print_render_skew "$dir" "$code" "$server_port"
  [ $fail = 0 ] && log "RUN $RUN_ID PASS ($dir)" || { log "RUN $RUN_ID had failures ($dir)"; exit 1; }
}

cmd_status() {
  log "devices:"; [ -f "$DEVICES_JSON" ] && jq -r '.[] | "  \(.label)\t\(.id)\t\(.model)"' "$DEVICES_JSON" || echo "  (none — run up)"
  for s in server metro; do
    if [ -f "$STATE/$s.pid" ] && kill -0 "$(cat "$STATE/$s.pid")" 2>/dev/null; then log "$s: running"; else log "$s: stopped"; fi
  done
}

# Sourced (tests): define functions only
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0
c=${1:-help}; shift || true
case $c in
  doctor|setup|up|down|status|server|metro|photos|build|install|open|shot|play) "cmd_$c" "$@";;
  bots) node "$QA/lab/bots.mjs" "$@";;
  *) sed -n '2,/^#   bots/p' "$0";;
esac
