#!/usr/bin/env bash
# ExposeMe device lab — boots iOS simulators + Android emulators, seeds photos,
# runs the local server/Metro, and drives multi-device games (Maestro + socket bots).
#
# Usage: qa/lab/lab.sh <command> [args]
#   doctor                      Check toolchain
#   setup                       One-time: install Maestro, create AVDs, npm deps for qa/
#   up [--ios N] [--android N]  Boot devices (default 2+2), grant perms, adb reverse, write devices.json
#   down [--worktrees]          Shut down all lab devices and background processes; --worktrees also stops the lab
#                               servers (server --port N) this checkout's git worktrees started (through their pidfiles)
#   status                      Show devices, every lab server by port (this checkout and its git worktrees), metro
#   server [--restart] [--port N] [--stop --port N]  Local Server on :3000 (log: qa/runs/server.log); --port for a
#                               worktree's own server. Stop/restart only touch the server this checkout started on that
#                               port (its pidfile), never another checkout's: --stop needs an explicit --port
#                               QA render telemetry on: qa-ack lines in qa/runs/telemetry.jsonl (telemetry-<port>.jsonl)
#   metro  [--restart]          Start Metro with EXPO_PUBLIC_SERVER_URL=http://localhost:3000 and EXPO_PUBLIC_QA=1
#   photos [N] [--reset] [--edge]  Seed N labelled photos per device gallery (default 12); idempotent: replaces the
#                               lab's own photos, never stacks copies (--reset: wipe lab photos / iOS photo library first;
#                               --edge: also 3 edge-case photos per gallery and for the bots: 3024x4032, 4032x3024 and
#                               one stored sideways with EXIF Orientation=6)
#   build [ios|android|all] [--prebuild]  Build dev-client binaries (slow, only when native deps change);
#                               --prebuild runs expo prebuild first (needed after app.json/package.json/config-plugin
#                               changes: build warns when they changed since the lab's last prebuild)
#   install                     Install the last built binaries on every lab device (non-zero if any install failed)
#   open                        Open the app on every device, pointed at local Metro (Android: cold start, like play)
#   shot <label>                Screenshot every device into qa/runs/<RUN_ID>/shots/<label>-<device>.png
#   play [--bots N] [--rounds R] [--devices all|pair|ios|android|none|<label,label>] [--flow play-game] [--bot-args "..."]
#                               Full multiplayer session: bots host a room, devices join and play; prints the bots
#                               summary, the device render skew per phase (qa/runs/<RUN_ID>/render-skew.json) and how
#                               many scoreboards each device checked (play-rounds.yaml), and keeps the game's raw
#                               telemetry rows (qa/runs/<RUN_ID>/telemetry.jsonl); warns unless Maestro is 2.11.x
#                               (--bot-args: extra bots.mjs flags, e.g. --flow no-result-game --bot-args --no-answer);
#                               a device whose flow failed while the dev client was still booting (stuck on its
#                               "Downloading N%", or dev-client-boot.yaml's loaded check failed: launcher, ANR dialog,
#                               "There was a problem loading the project") is force-stopped and runs the flow once
#                               more (maestro/<device>-retry)
#        [--second-room "<bots.mjs args>"]  also start a 2nd bots room; its code reaches the flows as NEW_CODE
#        [--maestro-env KEY=VALUE]          extra Maestro variable for every device (repeatable)
#        [--server http://localhost:P | --port P]  bots and render telemetry use that lab server (e.g. a worktree's
#                                           own: server --port P); devices and Metro always stay on :3000
#        [--device-host]                    the one selected device creates the room and starts it (its lobby's
#                                           default rounds: no --rounds; 3+ bots, no --name-prefix); the bots join the
#                                           code its flow posts to a loopback listener (CODE_SINK_URL), e.g.
#                                           --flow device-host-start (EXP-390)
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
# `open`'s link to local Metro, with the flags of dev-client-boot.yaml's openLink (keep in sync: lab-functions.test.sh):
# no dev-menu onboarding sheet and no dev menu opening over the app at launch (EXP-282, EXP-313)
DEV_CLIENT_URL="exp+expose-me://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${METRO_PORT}&disableOnboarding=1&disableAutoLaunch=1&__expo_disable_auto_launch=1"
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
# Client commands (Metro, native builds) must run on the Node major pinned in Client/.nvmrc, and on Expo's own
# major at least EXPO_NODE_MIN (Expo SDK 58 rejects older 24.x). Uses the default node when it fits, else the
# newest fitting nvm/Homebrew install; fails loudly (non-zero + message on stderr) when none is found.
EXPO_NODE_MIN=24.3.0
nvmrc_version() { # prints Client/.nvmrc without spaces or a leading "v" ("v24.3.0" → 24.3.0)
  local f="$ROOT/Client/.nvmrc" v
  [ -f "$f" ] || { echo "[lab] missing $f" >&2; return 1; }
  v="$(tr -d ' \r\n' <"$f")"; echo "${v#v}"
}
client_node_major() { # prints the major version pinned in Client/.nvmrc ("24", "v24.3.0" → 24)
  local v; v="$(nvmrc_version)" || return 1; v="${v%%.*}"
  [[ "$v" =~ ^[0-9]+$ ]] || { echo "[lab] cannot parse a Node major from $ROOT/Client/.nvmrc ('$(cat "$ROOT/Client/.nvmrc")')" >&2; return 1; }
  echo "$v"
}
version_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; } # a, b: exit 0 when a >= b
client_node_min() { # prints the oldest Node the Client accepts: Client/.nvmrc ("24" → 24.0.0), raised to EXPO_NODE_MIN
  local major min
  major="$(client_node_major)" || return 1
  min="$(nvmrc_version)"
  [[ "$min" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || min=$major
  until [[ "$min" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; do min="$min.0"; done
  # Expo's floor only applies on its own major: a future .nvmrc major brings its own minimum
  if [ "${EXPO_NODE_MIN%%.*}" = "$major" ] && ! version_ge "$min" "$EXPO_NODE_MIN"; then min=$EXPO_NODE_MIN; fi
  echo "$min"
}
node_fits() { [ "${1%%.*}" = "$2" ] && version_ge "$1" "$3"; } # version, major, min: on that major and >= min
client_path() {
  local want min cur bin p candidates=()
  want="$(client_node_major)" || return 1
  min="$(client_node_min)" || return 1
  cur="$(node -p 'process.versions.node' 2>/dev/null || echo none)"
  node_fits "$cur" "$want" "$min" && { echo "$PATH"; return 0; }
  # Newest nvm install of the major first, then Homebrew's node@<major>
  # (LAB_BREW_PREFIXES: space-separated Homebrew prefixes to search, overridable for tests)
  while IFS= read -r bin; do candidates+=("$bin"); done \
    < <(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin 2>/dev/null | sort -rV)
  for p in ${LAB_BREW_PREFIXES:-${HOMEBREW_PREFIX:-/opt/homebrew} /usr/local}; do candidates+=("$p/opt/node@$want/bin"); done
  for bin in "${candidates[@]}"; do
    [ -x "$bin/node" ] && node_fits "$("$bin/node" -p 'process.versions.node' 2>/dev/null)" "$want" "$min" \
      && { echo "$bin:$PATH"; return 0; }
  done
  printf '\033[1;31m[lab] Client needs Node %s >= %s (Client/.nvmrc, Expo SDK 58) but found node %s and no such install in nvm or Homebrew. Run: nvm install %s\033[0m\n' \
    "$want" "$min" "$cur" "$want" >&2
  return 1
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
  if [ -x "$MAESTRO" ]; then maestro_version_check || true; else echo "MISSING maestro (run: qa/lab/lab.sh setup)"; ok=0; fi
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
  local worktrees=0
  while [ $# -gt 0 ]; do case $1 in --worktrees) worktrees=1; shift;; *) die "bad arg $1 (usage: down [--worktrees])";; esac; done
  [ $worktrees = 1 ] && in_linked_worktree \
    && die "down --worktrees runs from the main checkout only (from a worktree it would stop the other agents' servers)"
  devices | while read -r d; do
    local id; id="$(jq -r .id <<<"$d")"
    if [ "$(jq -r .platform <<<"$d")" = ios ]; then xcrun simctl shutdown "$id" 2>/dev/null || true
    else adbs "$id" emu kill 2>/dev/null || true; fi
  done
  bg_stop server $SERVER_PORT || true; bg_stop metro $METRO_PORT || true
  [ $worktrees = 0 ] || stop_worktree_servers
  log "Lab down"
}

bg_command_of() { case $1 in metro) echo "expo start";; *) echo "ts-node server.ts";; esac; } # name: what it runs
bg_dir_of() { case $1 in metro) echo Client;; *) echo Server;; esac; } # name: the checkout dir bg_start runs it in
bg_pid_is() { # pid, name: exit 0 when that pid is alive and runs that lab process (a pidfile's pid may be reused)
  [ -n "$1" ] && [[ "$(ps -o command= -p "$1" 2>/dev/null)" == *"$(bg_command_of "$2")"* ]]
}
bg_running() { [ -f "$STATE/$1.pid" ] && bg_pid_is "$(cat "$STATE/$1.pid")" "$1"; } # name
bg_start() { # name, logfile, cwd, cmd...
  local name=$1 logf=$2 cwd=$3; shift 3
  if bg_running "$name"; then log "$name already running"; return 0; fi
  nohup bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" </dev/null >"$logf" 2>&1 &
  echo $! >"$STATE/$name.pid"
  log "$name started (pid $!, log $logf)"
}
# ── Stopping background processes (sourceable: qa/lab/tests/lab-server.test.sh) ──
# Only ever through this checkout's pidfile, never by port or by name: the port may belong to another checkout's lab
# (the shared :3000 seen from a git worktree) or to another agent's server (EXP-067)
BG_STOP_GRACE_TICKS=25   # x 0.2 s: how long the stopped processes get to exit before SIGKILL
process_tree() { # pid: prints the pid and all its descendants (npx → node, expo → metro workers...)
  local child; for child in $(pgrep -P "$1" 2>/dev/null); do process_tree "$child"; done; echo "$1"
}
port_listeners() { { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; } | tr '\n' ' ' | sed 's/ $//'; } # port: pids listening on it
pid_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; } # pid: its working directory
tree_listens_on() { # pid, port: exit 0 when that pid or one of its descendants listens on the port
  local p listeners=" $(port_listeners "$2") "
  for p in $(process_tree "$1"); do [[ $listeners == *" $p "* ]] && return 0; done
  return 1
}
# Another checkout's pidfile (down --worktrees) may be stale with its pid reused by another session's lab process: it
# is that checkout's only if it runs in that checkout's Server/Client dir (bg_start's cwd) or serves the pidfile's port
bg_pid_of_checkout() { # pid, name, port, checkout root
  local dir; dir="$(cd "$4/$(bg_dir_of "$2")" 2>/dev/null && pwd -P)" || return 1
  bg_pid_is "$1" "$2" && { [ "$(pid_cwd "$1")" = "$dir" ] || tree_listens_on "$1" "$3"; }
}
# Returns 0 when it stopped a process, 1 when there was nothing to stop (no pidfile, or a stale one: removed)
bg_stop() { # name, port, [another checkout's lab state dir holding the pidfile, default this checkout's]
  local pidfile="${3:-$STATE}/$1.pid" checkout="${3:+${3%/qa/runs/.lab}}" pid pids others stopped=1 owned
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    owned=(bg_pid_is "$pid" "$1")
    [ -z "$checkout" ] || owned=(bg_pid_of_checkout "$pid" "$1" "$2" "$checkout")
    if "${owned[@]}"; then
      pids="$(process_tree "$pid" | tr '\n' ' ')"
      kill $pids 2>/dev/null || true
      for _ in $(seq 1 $BG_STOP_GRACE_TICKS); do kill -0 $pids 2>/dev/null || break; sleep 0.2; done
      kill -9 $pids 2>/dev/null || true
      stopped=0
    else
      warn "stale $1 pidfile${checkout:+ of $checkout}: pid $pid is gone or no longer runs '$(bg_command_of "$1")'${checkout:+" from that checkout"}, removed without killing it"
    fi
    rm -f "$pidfile"
  fi
  others="$(port_listeners "$2")"
  [ -z "$others" ] || warn "port :$2 is still in use by pid(s) $others, which this lab checkout didn't start" \
    "(another checkout's lab server?): left running"
  return $stopped
}
in_linked_worktree() { [ -f "$ROOT/.git" ]; } # a linked git worktree has a .git file, the main checkout a .git dir
ensure_port_free() { # port, hint for a worktree: dies when something this checkout didn't start listens on the port
  local others; others="$(port_listeners "$1")"
  [ -n "$others" ] || return 0
  in_linked_worktree && die "port :$1 is already in use by pid(s) $others, which this worktree didn't start" \
    "(the main checkout's lab?). $2"
  die "port :$1 is already in use by pid(s) $others, which this lab checkout didn't start. Check it: ps -p ${others// /,};" \
    "if it is an orphaned lab process (its pidfile was lost), stop it by hand (kill $others) and run this again"
}

cmd_server() {
  # --port N runs a separate server (e.g. from a git worktree, for parallel fixers); --stop stops it
  local port=$SERVER_PORT port_given=0 restart=0 stop=0 others
  while [ $# -gt 0 ]; do case $1 in
    --restart) restart=1; shift;; --stop) stop=1; shift;; --port) port=$2; port_given=1; shift 2;; *) die "bad arg $1";; esac; done
  [ $stop = 1 ] && [ $port_given = 0 ] && die "server --stop needs the port it stops: --port N (--port $SERVER_PORT for the shared lab server)"
  local name=server logf="$RUNS/server.log" telemetry; telemetry="$(telemetry_file "$port")"
  [ "$port" != "$SERVER_PORT" ] && { name="server-$port"; logf="$RUNS/server-$port.log"; }
  if [ $stop = 1 ]; then
    if bg_stop "$name" "$port"; then log "$name stopped"; else log "$name was not running (nothing stopped)"; fi
    return 0
  fi
  [ $restart = 0 ] || bg_stop "$name" "$port" || true
  bg_running "$name" || ensure_port_free "$port" "Run your own: server --port N"
  # Bots/load tests: lift the per-player and per-room /upload rate limits, the /upload in-flight caps (including the
  # per-IP cap of a busy server), the stored-photo caps (server-wide and lobby photos per IP) and the per-IP socket
  # limits: open connections and new sessions per minute (every bot shares one IP) (override with
  # UPLOAD_PLAYER_RATE_MAX=... / UPLOAD_ROOM_RATE_MAX=... / UPLOAD_INFLIGHT_*=... / UPLOAD_STORED_MAX=... /
  # UPLOAD_LOBBY_PER_IP_MAX=... / SOCKET_MAX_CONNECTIONS_PER_IP=... / SOCKET_HANDSHAKE_RATE_MAX=... /
  # JOIN_MISS_MAX=... / JOIN_MISS_PREFIX_MAX=... / JOIN_MISS_GLOBAL_MAX=... / JOIN_MISS_PRESSURE_MAX=...).
  # Each value stays within the range the server accepts (envInt clamps it), checked by qa/lab/tests/lab-server.test.sh.
  # ALLOW_QA_ROUNDS=1: accept QA-only 3-round games (play --rounds 3); production never sets it
  # QA_TELEMETRY=1: record the qa-ack of QA builds (when each device rendered a phase) in $telemetry (play reads it);
  # a fresh server starts a fresh file, so it never grows across sessions
  bg_running "$name" || rotate_telemetry "$telemetry"
  bg_start "$name" "$logf" "$ROOT/Server" env PORT="$port" ALLOW_QA_ROUNDS=1 QA_TELEMETRY=1 QA_TELEMETRY_FILE="$telemetry" \
    UPLOAD_ROOM_RATE_MAX="${UPLOAD_ROOM_RATE_MAX:-100000}" \
    UPLOAD_PLAYER_RATE_MAX="${UPLOAD_PLAYER_RATE_MAX:-100000}" \
    UPLOAD_INFLIGHT_MAX="${UPLOAD_INFLIGHT_MAX:-10000}" UPLOAD_INFLIGHT_PER_IP_MAX="${UPLOAD_INFLIGHT_PER_IP_MAX:-10000}" \
    UPLOAD_INFLIGHT_PER_IP_BUSY_MAX="${UPLOAD_INFLIGHT_PER_IP_BUSY_MAX:-10000}" \
    UPLOAD_INFLIGHT_PER_ROOM_MAX="${UPLOAD_INFLIGHT_PER_ROOM_MAX:-10000}" UPLOAD_INFLIGHT_PER_MEMBER_MAX="${UPLOAD_INFLIGHT_PER_MEMBER_MAX:-10000}" \
    UPLOAD_STORED_MAX="${UPLOAD_STORED_MAX:-100000}" UPLOAD_LOBBY_PER_IP_MAX="${UPLOAD_LOBBY_PER_IP_MAX:-100000}" \
    SOCKET_MAX_CONNECTIONS_PER_IP="${SOCKET_MAX_CONNECTIONS_PER_IP:-100000}" \
    SOCKET_HANDSHAKE_RATE_MAX="${SOCKET_HANDSHAKE_RATE_MAX:-100000}" \
    JOIN_MISS_MAX="${JOIN_MISS_MAX:-100000}" JOIN_MISS_PREFIX_MAX="${JOIN_MISS_PREFIX_MAX:-1000000}" \
    JOIN_MISS_GLOBAL_MAX="${JOIN_MISS_GLOBAL_MAX:-10000000}" JOIN_MISS_PRESSURE_MAX="${JOIN_MISS_PRESSURE_MAX:-100000}" \
    npx ts-node server.ts
  for _ in $(seq 1 30); do curl -fs "http://localhost:$port/health" >/dev/null && { log "$name healthy on :$port"; return 0; }; sleep 1; done
  die "$name did not become healthy — see $logf"
}

cmd_metro() {
  [ "${1:-}" != --restart ] || bg_stop metro $METRO_PORT || true
  # A Metro this checkout didn't start (e.g. without EXPO_PUBLIC_QA) would otherwise pass as "metro ready"
  bg_running metro || ensure_port_free "$METRO_PORT" "Metro is shared: run it from the main checkout"
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
#  - --edge (opt-in, EXP-083): also the edge-case set of `make-photos.swift --edge`, exposeme-lab-<label>-edge-<kind>.jpg
#    (large portrait and landscape, one stored sideways with EXIF Orientation=6). Android pushes them with the numbered
#    photos, so a later run without --edge drops them; iOS imports them once (own marker) and keeps them until --reset.
LAB_PHOTO_PREFIX="exposeme-lab-"
LAB_EDGE_TAG="-edge-"   # edge-case photos are <prefix><label>-edge-<kind>.jpg: not numbered
ANDROID_PHOTO_DIR="/sdcard/Pictures/ExposeMeQA"
IOS_PHOTO_MARKER="${LAB_PHOTO_PREFIX}seeded"
IOS_EDGE_MARKER="${IOS_PHOTO_MARKER}-edge"
SIM_DEVICES_DIR="${SIM_DEVICES_DIR:-$HOME/Library/Developer/CoreSimulator/Devices}"
DEFAULT_PHOTO_COUNT=12

parse_photos_args() { # [N] [--reset] [--edge] -> sets PHOTOS_N, PHOTOS_RESET and PHOTOS_EDGE (0|1); returns 1 on a bad argument
  PHOTOS_N=$DEFAULT_PHOTO_COUNT PHOTOS_RESET=0 PHOTOS_EDGE=0
  while [ $# -gt 0 ]; do
    case $1 in
      --reset) PHOTOS_RESET=1;;
      --edge) PHOTOS_EDGE=1;;
      *) [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo "[lab] photos: bad argument '$1' (usage: photos [N] [--reset] [--edge])" >&2; return 1; }
         PHOTOS_N=$1;;
    esac
    shift
  done
}
generate_lab_photos() { # dir, label, count: fresh labelled photos, no leftovers from an older run
  rm -rf "$1"; mkdir -p "$1"
  swift "$QA/lab/make-photos.swift" "$1" "$2" "$3" "$LAB_PHOTO_PREFIX"
}
generate_edge_photos() { # dir, label: a fresh edge-case set next to the numbered photos (which it keeps)
  mkdir -p "$1"; rm -f "$1/$LAB_PHOTO_PREFIX$2$LAB_EDGE_TAG"*.jpg
  swift "$QA/lab/make-photos.swift" --edge "$1" "$2" "$LAB_PHOTO_PREFIX"
}
lab_photos_from() { # dir, first index: the generated photos numbered >= first index, in order
  local f i
  for f in "$1/$LAB_PHOTO_PREFIX"*.jpg; do
    [ -e "$f" ] || continue
    i="${f##*-}"; i="${i%.jpg}"
    [[ "$i" =~ ^[0-9]+$ ]] || continue   # an edge-case photo: not numbered
    [ $((10#$i)) -ge "$2" ] && echo "$f"
  done
  return 0
}
lab_edge_photos() { # dir: the generated edge-case photos, in order
  local f
  for f in "$1/$LAB_PHOTO_PREFIX"*"$LAB_EDGE_TAG"*.jpg; do [ -e "$f" ] && echo "$f"; done
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
  rm -rf "$media/DCIM" "$media/PhotoData" "$media/$IOS_PHOTO_MARKER" "$media/$IOS_EDGE_MARKER" || { echo "could not delete the photo library in $media"; return 1; }
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
ios_seed_edge_photos() { # udid, dir, label; once per photo library (marker). Prints what it did, or why it failed (non-zero)
  local udid=$1 dir=$2 label=$3 marker f files=()
  check_sim_dir "$udid" || return 1
  marker="$(ios_media_dir "$udid")/$IOS_EDGE_MARKER"
  [ -f "$marker" ] && { echo "edge-case photos already added"; return 0; }
  generate_edge_photos "$dir" "$label" >/dev/null || { echo "make-photos.swift --edge failed"; return 1; }
  while read -r f; do files+=("$f"); done < <(lab_edge_photos "$dir")
  [ ${#files[@]} -gt 0 ] || { echo "no generated edge-case photos in $dir"; return 1; }
  xcrun simctl addmedia "$udid" "${files[@]}" || { echo "simctl addmedia of the edge-case photos failed (not marked as added)"; return 1; }
  mkdir -p "${marker%/*}" && echo "$label" >"$marker" || { echo "could not write $marker"; return 1; }
  echo "added ${#files[@]} edge-case photos"
}

cmd_photos() {
  parse_photos_args "$@" || exit 1
  local n=$PHOTOS_N reset=$PHOTOS_RESET edge=$PHOTOS_EDGE
  devices | while read -r d; do
    local label id plat dir out
    label="$(jq -r .label <<<"$d")"; id="$(jq -r .id <<<"$d")"; plat="$(jq -r .platform <<<"$d")"
    dir="$RUNS/photos/$label"
    if [ "$plat" = ios ]; then
      out="$(ios_seed_photos "$id" "$dir" "$label" "$n" "$reset")" || die "$label: $out"
      log "$label: $out"
      if [ "$edge" = 1 ]; then
        out="$(ios_seed_edge_photos "$id" "$dir" "$label")" || die "$label: $out"
        log "$label: $out"
      fi
    else
      local seeded="$n photos"
      generate_lab_photos "$dir" "$label" "$n" >/dev/null
      if [ "$edge" = 1 ]; then generate_edge_photos "$dir" "$label" >/dev/null; seeded+=" + edge-case photos"; fi
      android_seed_photos "$id" "$dir" "$reset" "$label"
      log "$label: $seeded (previous lab photos replaced)"
    fi
  done || exit 1   # a device that failed (die in the pipeline's subshell) stops the command
  generate_lab_photos "$RUNS/photos/bots" "bot" "$n"
  if [ "$edge" = 1 ]; then generate_edge_photos "$RUNS/photos/bots" "bot"; fi
}

# ── Native prebuild (sourceable: qa/lab/tests/lab-functions.test.sh) ──
# Client/ios and Client/android are generated by `expo prebuild` and not versioned: app.json (and the icons/splash it
# points to), package.json and config-plugin changes only reach the lab binaries through a new prebuild (EXP-255,
# EXP-086). After each prebuild
# the lab stores a hash of those inputs per platform, and `build` warns when they changed since.
app_json_files() { # the files Client/app.json points to ("./assets/images/icon.png", splash, adaptive icon...)
  local client="$ROOT/Client" rel
  [ -f "$client/app.json" ] || return 0
  grep -oE '"\./[^"]+"' "$client/app.json" | tr -d '"' | LC_ALL=C sort -u | while read -r rel; do
    [ -f "$client/${rel#./}" ] && echo "$client/${rel#./}"
  done
  return 0
}
prebuild_inputs() { # the Client files expo prebuild reads, one path per line (only those that exist)
  local f
  for f in "$ROOT/Client/app.json" "$ROOT/Client/app.config.js" "$ROOT/Client/app.config.ts" "$ROOT/Client/package.json"; do
    [ -f "$f" ] && echo "$f"
  done
  app_json_files
  [ -d "$ROOT/Client/plugins" ] && find "$ROOT/Client/plugins" -type f | LC_ALL=C sort
  return 0
}
prebuild_hash() { # one hash of every prebuild input's path and content
  local f
  prebuild_inputs | while read -r f; do echo "${f#"$ROOT/"}"; cat "$f"; done | shasum -a 256 | awk '{print $1}'
}
prebuild_hash_file() { echo "$STATE/prebuild-hash-$1"; } # platform
prebuild_mark_done() { local p; for p in "$@"; do prebuild_hash >"$(prebuild_hash_file "$p")"; done; } # platforms...
prebuild_stale() { # platform: exit 0 when the lab has no prebuild of it matching the current inputs
  [ "$(cat "$(prebuild_hash_file "$1")" 2>/dev/null)" != "$(prebuild_hash)" ]
}
run_prebuild() { # Client PATH, ios|android|all: expo prebuild (npm/pod install left to build), then records its inputs
  local cpath=$1 what=$2 platforms=(ios android)
  [ "$what" = all ] || platforms=("$what")
  log "Running expo prebuild --platform $what (log: $RUNS/prebuild.log)"
  (cd "$ROOT/Client" && PATH="$cpath" CI=1 npx expo prebuild --no-install --platform "$what") >"$RUNS/prebuild.log" 2>&1 \
    || { warn "expo prebuild FAILED — tail $RUNS/prebuild.log"; return 1; }
  prebuild_mark_done "${platforms[@]}"
  log "expo prebuild OK"
}

build_ios() { # Client PATH
  log "Building iOS dev client with xcodebuild (slow, log: $RUNS/build-ios.log)"
  pods_stale "$ROOT/Client/ios" && log "Pods missing or out of sync with Podfile.lock: running pod install"
  # expo run:ios needs Simulator.app to resolve devices; xcodebuild + simctl install does not
  # Every target (incl. pods declaring older minimums) builds at the app's prebuild deployment target
  (cd "$ROOT/Client/ios" && export PATH="$1" && { ! pods_stale . || { pod install && pods_mark_installed .; }; } \
    && dt="$(grep -m1 -o 'IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*' ExposeMe.xcodeproj/project.pbxproj | awk '{print $3}')" \
    && xcodebuild -workspace ExposeMe.xcworkspace -scheme ExposeMe \
    -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$ROOT/Client/ios/build" CODE_SIGNING_ALLOWED=NO IPHONEOS_DEPLOYMENT_TARGET="$dt" build) >"$RUNS/build-ios.log" 2>&1 \
    && echo "$ROOT/Client/ios/build/Build/Products/Debug-iphonesimulator/ExposeMe.app" >"$STATE/ios-app-path" \
    && log "iOS build OK" || { log "iOS build FAILED — tail $RUNS/build-ios.log"; return 1; }
}

build_android() { # Client PATH
  log "Building Android dev client (slow, log: $RUNS/build-android.log)"
  (cd "$ROOT/Client/android" && PATH="$1" ./gradlew :app:assembleDebug) >"$RUNS/build-android.log" 2>&1 \
    && echo "$ROOT/Client/android/app/build/outputs/apk/debug/app-debug.apk" >"$STATE/android-apk-path" \
    && log "Android build OK" || { log "Android build FAILED — tail $RUNS/build-android.log"; return 1; }
}

cmd_build() { # [ios|android|all] [--prebuild]
  local what=all prebuild=0 rc=0 cpath p platforms
  while [ $# -gt 0 ]; do case $1 in
    ios|android|all) what=$1;; --prebuild) prebuild=1;;
    *) die "bad arg $1 (usage: build [ios|android|all] [--prebuild])";; esac; shift; done
  platforms=(ios android); [ "$what" = all ] || platforms=("$what")
  cpath="$(client_path)" || exit 1
  for p in "${platforms[@]}"; do
    [ -d "$ROOT/Client/$p" ] || { log "Client/$p does not exist yet: running expo prebuild first"; prebuild=1; }
  done
  if [ $prebuild = 1 ]; then
    run_prebuild "$cpath" "$what" || exit 1
  else
    for p in "${platforms[@]}"; do
      prebuild_stale "$p" && warn "Client/$p may be out of date: app.json, package.json or config plugins changed since" \
        "the lab's last prebuild (or the lab never prebuilt it). Run: lab.sh build $what --prebuild"
    done
  fi
  for p in "${platforms[@]}"; do "build_$p" "$cpath" || rc=1; done
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

# Boots like dev-client-boot.yaml: on Android the link cold-starts the app (a running dev client can drop it, EXP-296,
# and only a loaded link applies disableAutoLaunch), iOS handles it on a running app
cmd_open() {
  devices | while read -r d; do
    local id platform; id="$(jq -r .id <<<"$d")"; platform="$(jq -r .platform <<<"$d")"
    if [ "$platform" = ios ]; then xcrun simctl openurl "$id" "$DEV_CLIENT_URL"
    else
      stop_app "$platform" "$id"
      adbs "$id" shell am start -a android.intent.action.VIEW -d "'$DEV_CLIENT_URL'" >/dev/null
    fi
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
  rm -f "$1/render-skew.json"   # a reused RUN_ID must not keep an older game's skew
  [ -s "$file" ] || return 0
  log "device render skew (ms, spread of qa-ack receipt across devices):"
  node "$QA/lab/render-skew.mjs" "$file" "$2" | tee "$1/render-skew.json" || true
}

save_game_telemetry() { # dir, room code, [server port]: that room's raw telemetry rows -> dir/telemetry.jsonl (EXP-319)
  # The server's file is rotated on its next start, so the run keeps its own copy for later per-round analysis.
  # Rows are copied verbatim, in file order; malformed lines are skipped. No rows (no QA build played): no copy.
  local file out="$1/telemetry.jsonl" rows; file="$(telemetry_file "${3:-$SERVER_PORT}")"
  rm -f "$out"   # a reused RUN_ID must not keep an older game's rows
  [ -s "$file" ] || return 0
  jq -rR --arg code "$2" '. as $line | fromjson? | select(type == "object" and .gameCode == $code) | $line' \
    "$file" >"$out.tmp" 2>/dev/null || true
  rows="$(grep -c . "$out.tmp" || true)"
  if [ "${rows:-0}" -gt 0 ]; then mv -f "$out.tmp" "$out"; log "telemetry of room $2: $rows rows saved in $out"
  else rm -f "$out.tmp"; fi
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

# ── Device flows: one retry when the dev client got stuck booting (EXP-256, EXP-297) ──
# With 4 devices loading the bundle from Metro at once, a dev client sometimes freezes on "Downloading 55.0%…", stays
# on its launcher, shows an "isn't responding" dialog or "There was a problem loading the project" (dev-client-boot.yaml
# fails at once on that one since EXP-298), and open-app.yaml fails before the device ever joins. The room is still waiting
# for it, so force-stopping the app and running the flow again (open-app.yaml relaunches it) saves the run.
BUNDLE_DOWNLOAD_TEXT_RE='"text" *: *"Downloading [0-9]+(\.[0-9]+)?%'
# The dev client's load error screen (Expo dev-client UI, always English): only names the reason in the retry log
LOAD_ERROR_TEXT='There was a problem loading the project'
# dev-client-boot.yaml's assertion that the bundle wait saw the app load (lab-play.test.sh checks the flow keeps it)
# shellcheck disable=SC2016 # a Maestro expression, not a shell one
BOOT_LOADED_CONDITION='${output.devClientBoot.loaded}'
# The devices that did join wait in the lobby (wait-game-start.yaml, env LOBBY_WAIT_MS) for the retried one, so that
# wait must cover it: the stuck attempt fails when dev-client-boot.yaml's bundle wait runs out. Its 120 s deadline is
# absolute (EXP-288), so in the worst case that is ~20 s to launch and open the link + 120 s + the poll under way at the
# deadline (<= ~21 s of screen lookups, ~31 s more if it is picking the server in the launcher): <= ~190 s after the
# flow started (~190 s measured in it51-r2). The retry opens the app and joins again (<= ~150 s). Counted from the
# other devices' own join, which comes after their own open, it is below 190 + 150 s; the margin covers slower machines.
STUCK_ATTEMPT_S=190
RETRY_OPEN_JOIN_S=150
LOBBY_WAIT_MARGIN_S=80
LOBBY_WAIT_MS=$(((STUCK_ATTEMPT_S + RETRY_OPEN_JOIN_S + LOBBY_WAIT_MARGIN_S) * 1000))   # keep in sync: wait-game-start.yaml

last_failure_hierarchy() { # maestro --test-output-dir: the screen hierarchy Maestro saved for the last failed step
  # Files are step-NNN-<command>.json; the step number is compared numerically (long flows pass step 999)
  find "$1" -path '*/screen-hierarchy/step-*.json' 2>/dev/null \
    | awk -F/ '{ n = $NF; sub(/^step-/, "", n); sub(/-.*/, "", n); print n + 0 "\t" $0 }' | sort -n | tail -1 | cut -f2-
}

stuck_on_bundle_download() { # maestro --test-output-dir: exit 0 when the failed run ended on the bundle download
  local h; h="$(last_failure_hierarchy "$1")"
  [ -n "$h" ] && grep -Eq "$BUNDLE_DOWNLOAD_TEXT_RE" "$h"
}

boot_check_failed() { # maestro --test-output-dir: exit 0 when the failed step was dev-client-boot.yaml's loaded check
  # (its bundle wait ran out, or it gave up at once on the load error screen)
  # commands.json lists every command run, nested ones included, with its status
  local f
  while read -r f; do
    jq -e --arg c "$BOOT_LOADED_CONDITION" \
      'any(.[]; .metadata.status == "FAILED" and .command.assertConditionCommand.condition.scriptCondition == $c)' \
      "$f" >/dev/null 2>&1 && return 0
  done < <(find "$1" -name commands.json 2>/dev/null)
  return 1
}

showed_load_error() { # maestro --test-output-dir: exit 0 when the last failed step's screen is the load error
  local h; h="$(last_failure_hierarchy "$1")"
  [ -n "$h" ] && grep -qF "$LOAD_ERROR_TEXT" "$h"
}

stuck_booting_reason() { # maestro --test-output-dir: prints why the failed run never got past the dev client's boot;
  # exit 1, printing nothing, when it did get past it
  if stuck_on_bundle_download "$1"; then echo 'stuck on its "Downloading N%"'
  elif ! boot_check_failed "$1"; then return 1
  elif showed_load_error "$1"; then echo "showed \"$LOAD_ERROR_TEXT\""
  else echo "dev-client-boot.yaml's bundle wait ran out"; fi
}

stop_app() { # platform, device id
  if [ "$1" = ios ]; then xcrun simctl terminate "$2" "$APP_ID" 2>/dev/null || true
  else adbs "$2" shell am force-stop "$APP_ID" || true; fi
}

run_maestro_flow() { # device id, flow file, output dir, run name, maestro args... → output dir/<run name>{/,.xml,.log}
  local id=$1 flow=$2 out=$3 name=$4; shift 4
  # A reused RUN_ID leaves an older run's hierarchies there: only this run's must decide the retry
  rm -rf "${out:?}/$name"
  "$MAESTRO" --device "$id" test "$flow" "$@" \
    --test-output-dir "$out/$name" --format junit --output "$out/$name.xml" >"$out/$name.log" 2>&1
}

run_device_flow() { # device json, flow file, output dir, maestro args...: the flow, re-run once after a stuck boot
  local d=$1 flow=$2 out=$3 id label platform; shift 3
  id="$(jq -r .id <<<"$d")"; label="$(jq -r .label <<<"$d")"; platform="$(jq -r .platform <<<"$d")"
  run_maestro_flow "$id" "$flow" "$out" "$label" "$@" && return 0
  local reason; reason="$(stuck_booting_reason "$out/$label")" || return 1
  warn "$label: dev client stuck loading the JS bundle ($reason); force-stopping the app and running" \
    "$(basename "$flow") once more" \
    "(results in $out/$label-retry)"
  stop_app "$platform" "$id"
  run_maestro_flow "$id" "$flow" "$out" "$label-retry" "$@"
}

# ── play-rounds.yaml: the Maestro it was verified on, and how many scoreboards each device checked (EXP-312) ──
# The flow times its looks by Maestro 2.11's rules (a condition waits less after a command acted on the device, and an
# evalScript counts as one), read from its bytecode and modelled by qa/lab/tests/maestro-sim.mjs
MAESTRO_VERIFIED_VERSION=2.11
# The guard of play-rounds.yaml's card wait (keep in sync: lab-play.test.sh checks the flow has it): Maestro's
# commands.json lists it once per pass of the round loop, SKIPPED when that pass didn't wait for a scoreboard, and the
# first pass has none to wait for
# shellcheck disable=SC2016 # a Maestro expression, not a shell one
SCOREBOARD_GUARD='${Date.now() + output.round.readMs / 2 < output.round.closesAfter}'
# The guard of its checks after the card wait (EXP-353): COMPLETED when the wait saw the card (or the held marker); a
# scoreboard whose card no look saw is left unchecked (lab-play.test.sh checks the flow has it)
# shellcheck disable=SC2016
CHECKED_GUARD='${output.round.cardWaited && ++output.scoreboards.checked}'
# The script guard of its look for the held marker (EXP-325): COMPLETED when that look found a checked scoreboard held,
# which then counts as held, not checked (lab-play.test.sh checks the flow has it)
# shellcheck disable=SC2016
HELD_GUARD='${!output.options.shown && output.round.cardWaited && !output.round.heldLooked && Date.now() > output.round.closesBy + output.timing.heldLookDelayMs && (output.round.heldLooked = true)}'
# The fewest card waits, all without seeing a card nor the held marker, that fail a run checking none (EXP-353): a
# slow phone's single card wait often misses its card (maestro-sim.mjs reads it from here)
NONE_CHECKED_MIN_WAITS=2

maestro_version_check() { # warns (exit 1) unless the Maestro CLI is the version play-rounds.yaml was verified on
  local version; version="$("$MAESTRO" --version 2>/dev/null | tail -1)"
  [[ $version == "$MAESTRO_VERIFIED_VERSION".* ]] && return 0
  warn "Maestro ${version:-(unknown version)} is not $MAESTRO_VERIFIED_VERSION.x, the one play-rounds.yaml's timing was" \
    "verified on (EXP-312): check its condition timeouts against qa/lab/tests/maestro-sim.mjs"
  return 1
}

scoreboards_checked() { # maestro --test-output-dir: "<checked> <shown> <held> <waited> <unseen> <failed>" of its
  # play-rounds.yaml run (scoreboards checked, shown, found held, waited for, and waited for without seeing the card nor
  # the held marker; whether a Maestro step failed), or nothing
  local f; f="$(find "$1" -name commands.json 2>/dev/null | head -1)"
  [ -n "$f" ] || return 0
  jq -r --arg guard "$SCOREBOARD_GUARD" --arg checked "$CHECKED_GUARD" --arg held "$HELD_GUARD" '
    def completed($condition): [.[] | select(.command.runFlowCommand.condition.scriptCondition == $condition
      and .metadata.status == "COMPLETED")] | length;
    [.[] | select(.command.runFlowCommand.condition.scriptCondition == $guard)] as $passes
    | select($passes | length > 0)
    | completed($held) as $held | completed($checked) as $reached | completed($guard) as $waited
    | (if any(.[]; .metadata.status == "FAILED") then 1 else 0 end) as $failed
    | "\($reached - $held) \($passes | length - 1) \($held) \($waited) \($waited - $reached) \($failed)"' "$f" 2>/dev/null
}

print_scoreboards_checked() { # maestro output dir: one line per device run that played rounds; fails (exit 1) when a
  # run checked no scoreboard and found none held though at least NONE_CHECKED_MIN_WAITS card waits ran: they all ended
  # without seeing a card, so a card missing on every round (EXP-353: the flow itself never fails on a scoreboard it
  # can't tell; maestro-sim.mjs sees a correct game end that way only with random 2.5-4 s reads, under 1 % of them).
  # A run that failed in Maestro already fails, and
  # one with fewer card waits (a phone too slow for their guard) can't tell: both only warn. Also warns about the
  # scoreboards waited for whose card no look saw (unchecked: a phone too slow to tell, or a card missing on that round)
  local run counts checked shown held waited unseen failed device none=0
  for run in "$1"/*/; do
    counts="$(scoreboards_checked "$run")"
    [ -n "$counts" ] || continue
    read -r checked shown held waited unseen failed <<<"$counts"
    device="$(basename "$run")"
    log "$device: $checked/$shown scoreboards checked, $held held (play-rounds.yaml)"
    [ "$unseen" = 0 ] \
      || warn "$device: $unseen scoreboard(s) waited for without seeing the card or the held marker (unchecked: a phone too slow to tell, or the card missing)"
    [ "$checked" = 0 ] && [ "$shown" -gt 0 ] && [ "$failed" = 0 ] || continue
    if [ "$waited" = 0 ]; then
      warn "$device: no scoreboard reached in time: phone too slow to check"
    elif [ "$waited" -lt "$NONE_CHECKED_MIN_WAITS" ]; then
      warn "$device: no scoreboard checked, $waited waited for: too few to tell a missing card from a phone too slow"
    elif [ "$held" = 0 ]; then
      warn "$device: NONE CHECKED: no scoreboard showed its card: is the card missing? see the round screenshots"
      none=1
    else
      warn "$device: no scoreboard checked, $held found held: the photo owner held them, so their cards went unseen"
    fi
  done
  [ $none = 0 ]
}

wait_room_code() { # dir, label: prints the room code the bots wrote to dir/code, or dies
  local dir=$1 label=$2 i
  for ((i = 0; i < ${LAB_ROOM_CODE_TIMEOUT:-$ROOM_CODE_TIMEOUT_S}; i++)); do [ -s "$dir/code" ] && break; sleep 1; done
  [ -s "$dir/code" ] || die "$label did not create a room — see $dir/bots.log"
  cat "$dir/code"
}

# ── Device-hosted rooms (play --device-host, EXP-390) ──
# The device creates the room, so its code is only on its screen: the flow reads it and POSTs it with Maestro's http
# (run by the Maestro CLI on this machine) to a listener on loopback, which writes the first one it gets where a bots
# room leaves its code. The bots then join that code.
# The device posts once it is in its lobby, so this covers the lobby budget: a stuck boot and its retry (LOBBY_WAIT_MS)
DEVICE_ROOM_CODE_TIMEOUT_S=$((LOBBY_WAIT_MS / 1000))
# A room code as the server makes them (Server/managers/roomCode.ts; lab-device-host.test.sh checks the copy matches)
ROOM_CODE_ALPHABET=23456789ABCDEFGHJKMNPQRSTUVWXYZ
ROOM_CODE_LENGTH=6
# The listener answers 200 for the room code (again for the same one), 409 for another code once it has one, and 400
# for anything that is not a room code
CODE_SINK_JS='
const fs = require("fs");
const [file, portFile, alphabet, length] = process.argv.slice(1);
const roomCode = new RegExp(`^[${alphabet}]{${length}}$`);
const server = require("http").createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const code = body.trim();
    if (req.method !== "POST" || !roomCode.test(code)) res.statusCode = 400;
    else if (!fs.existsSync(file)) { fs.writeFileSync(`${file}.tmp`, code); fs.renameSync(`${file}.tmp`, file); }
    else if (fs.readFileSync(file, "utf8") !== code) res.statusCode = 409;
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
'
CODE_SINK_START_POLLS=50          # x 0.1 s for the listener to report its port
# device-host-start.yaml removes bot3 and guesses bot1: the bots need their own names, and at least three of them
DEVICE_HOST_MIN_BOTS=3
BOTS_NAME_PREFIX_RE='(^|[[:space:]])--name-prefix([[:space:]=]|$)'

start_code_sink() { # file: starts the room code listener (stopped with the bots on exit); sets CODE_SINK_URL
  local file=$1 port_file="$1.sink-port" i
  rm -f "$file" "$port_file"
  node -e "$CODE_SINK_JS" "$file" "$port_file" "$ROOM_CODE_ALPHABET" "$ROOM_CODE_LENGTH" &
  PLAY_BG_PIDS+=("$!")
  for ((i = 0; i < CODE_SINK_START_POLLS; i++)); do [ -s "$port_file" ] && break; sleep 0.1; done
  [ -s "$port_file" ] || die "the room code listener did not start"
  CODE_SINK_URL="http://127.0.0.1:$(cat "$port_file")/room-code"
}

wait_device_room_code() { # dir, flow pid: prints the code the device's flow posted (dir/code), or dies when the flow
  # ended without posting one or DEVICE_ROOM_CODE_TIMEOUT_S passed
  local dir=$1 pid=$2 i
  for ((i = 0; i < ${LAB_DEVICE_ROOM_CODE_TIMEOUT:-$DEVICE_ROOM_CODE_TIMEOUT_S}; i++)); do
    [ -s "$dir/code" ] && break
    kill -0 "$pid" 2>/dev/null || break   # the code check after the loop still sees a post made just before it ended
    sleep 1
  done
  [ -s "$dir/code" ] || die "the device did not post its room code — see $dir/maestro"
  cat "$dir/code"
}

process_tree() { # pid: prints it and all its descendants (by parent pid, never by name), parents first
  local child; echo "$1"
  for child in $(pgrep -P "$1" 2>/dev/null); do process_tree "$child"; done
}

stop_process_tree() { # pid: stops it and its descendants, all listed before any is signalled (none lost to a reparent)
  local tree; tree="$(process_tree "$1")"
  # shellcheck disable=SC2086 # one pid per word
  kill $tree 2>/dev/null || true
}

cmd_play() {
  local bots=3 rounds=10 which=all flow=play-game bot_args="" second_room="" maestro_env=() server_port=$SERVER_PORT
  local device_host=0 rounds_given=0
  while [ $# -gt 0 ]; do case $1 in
    --bots) bots=$2; shift 2;; --rounds) rounds=$2; rounds_given=1; shift 2;; --devices) which=$2; shift 2;; --flow) flow=$2; shift 2;;
    --device-host) device_host=1; shift;;
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
  if [ "$device_host" = 1 ]; then
    [ "$n_dev" = 1 ] || die "--device-host needs exactly one device, the room's host (got $n_dev)"
    [ "$server_port" = "$SERVER_PORT" ] \
      || die "--device-host: the device's room is on the shared server :$SERVER_PORT, so the bots play there too (no --server/--port)"
    [ "$rounds_given" = 0 ] || die "--device-host: the device's game plays its lobby's default rounds, drop --rounds"
    [ "$bots" -ge "$DEVICE_HOST_MIN_BOTS" ] \
      || die "--device-host needs at least $DEVICE_HOST_MIN_BOTS bots: device-host-start.yaml removes bot3 (got --bots $bots)"
    [[ ! $bot_args =~ $BOTS_NAME_PREFIX_RE ]] \
      || die "--device-host: device-host-start.yaml names the bots bot1..botN, drop --name-prefix from --bot-args"
  fi
  local rounds_desc="$rounds rounds"; [ "$device_host" = 0 ] || rounds_desc="the lobby's default rounds"
  log "RUN $RUN_ID: $bots bots + $n_dev devices, $rounds_desc, server $server_url"
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
  local code bots_pid pids=() metro_url="http%3A%2F%2Flocalhost%3A$METRO_PORT"
  if [ "$device_host" = 1 ]; then
    # The device creates the room: its flow posts the code, then the bots join it
    local host_device host_label; host_device="$(devices | jq -c "$sel")"; host_label="$(jq -r .label <<<"$host_device")"
    start_code_sink "$dir/code"
    maestro_version_check || true
    run_device_flow "$host_device" "$QA/maestro/$flow.yaml" "$dir/maestro" \
      -e USERNAME="$host_label" -e CODE_SINK_URL="$CODE_SINK_URL" -e METRO_URL="$metro_url" \
      ${maestro_env[@]+"${maestro_env[@]}"} &
    pids+=($!)
    # A flow still running without having posted (timeout) is stopped with its Maestro, not left behind
    code="$(wait_device_room_code "$dir" "${pids[0]}")" || { stop_process_tree "${pids[0]}"; exit 1; }
    log "room $code (created by $host_label)"
    # shellcheck disable=SC2086 # bot_args is a list of bots.mjs flags
    start_bots_room "$dir" "$server_url" --bots "$bots" --code "$code" $bot_args
    bots_pid=$BOTS_PID
  else
    # shellcheck disable=SC2086 # bot_args is a list of bots.mjs flags
    start_bots_room "$dir" "$server_url" --bots "$bots" --host --rounds "$rounds" --wait-players "$total" $bot_args
    bots_pid=$BOTS_PID
    code="$(wait_room_code "$dir" "bots")" || exit 1
    log "room $code"
    [ "$n_dev" = 0 ] || maestro_version_check || true
    while read -r d; do
      [ -n "$d" ] || continue
      local dl; dl="$(jq -r .label <<<"$d")"
      run_device_flow "$d" "$QA/maestro/$flow.yaml" "$dir/maestro" \
        -e GAME_CODE="$code" -e USERNAME="$dl" -e METRO_URL="$metro_url" -e LOBBY_WAIT_MS="$LOBBY_WAIT_MS" \
        ${maestro_env[@]+"${maestro_env[@]}"} &
      pids+=($!)
    done < <(devices | jq -c "$sel")
  fi
  local fail=0
  for p in "${pids[@]:-}"; do [ -n "$p" ] && { wait "$p" || fail=1; }; done
  # A device-hosted game has nobody else to start or play it: once the host's flow failed, don't wait the bots out
  if [ "$device_host" = 1 ] && [ $fail = 1 ]; then
    warn "the hosting device's flow failed: stopping the bots"
    kill "$bots_pid" 2>/dev/null || true
  fi
  wait $bots_pid || fail=1
  forget_bots_pid "$bots_pid"
  stop_play_bots
  node -e 'const r=require(process.argv[1]);console.log(JSON.stringify(r.summary,null,2))' "$dir/bots.json" 2>/dev/null || true
  print_render_skew "$dir" "$code" "$server_port"
  print_scoreboards_checked "$dir/maestro" || fail=1
  save_game_telemetry "$dir" "$code" "$server_port"
  [ $fail = 0 ] && log "RUN $RUN_ID PASS ($dir)" || { log "RUN $RUN_ID had failures ($dir)"; exit 1; }
}

# ── Status (sourceable: qa/lab/tests/lab-server.test.sh) ──
lab_state_dirs() { # this checkout's lab state dir, then the other git worktrees' (one path per line)
  local here wt
  echo "$STATE"
  here="$(cd "$ROOT" && pwd -P)"
  git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r wt; do
    [ "$(cd "$wt" 2>/dev/null && pwd -P)" = "$here" ] || echo "$wt/qa/runs/.lab"
  done
}
linked_worktree_state_dirs() { # the lab state dir of every linked git worktree (never the main checkout's), one per line
  # `git worktree list` names the main checkout first
  git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n 's|^worktree \(.*\)|\1/qa/runs/.lab|p' | tail -n +2
}
server_port_of() { case $1 in server) echo "$SERVER_PORT";; *) echo "${1#server-}";; esac; } # pidfile name: its port
servers_status() { # one line per lab server pidfile (server.pid, server-<port>.pid) of every lab state dir, by port
  local dir f name pid state where
  lab_state_dirs | while IFS= read -r dir; do
    for f in "$dir"/server.pid "$dir"/server-*.pid; do
      [ -f "$f" ] || continue
      name="$(basename "$f" .pid)"; pid="$(cat "$f")"; where=""
      [ "$dir" = "$STATE" ] || where="  (${dir%/qa/runs/.lab})"
      if bg_pid_is "$pid" "$name"; then state="running (pid $pid)"; else state="stopped (stale pidfile)"; fi
      printf '  :%s\t%s%s\n' "$(server_port_of "$name")" "$state" "$where"
    done
  done
}
# down --worktrees (EXP-279): the servers the worktrees started keep their pidfiles in each worktree's qa/runs, which a
# plain down never reads. Main checkout only (cmd_down checks it): from a worktree it would stop the other agents' servers
stop_worktree_servers() {
  local dir f name
  while IFS= read -r dir; do
    for f in "$dir"/server.pid "$dir"/server-*.pid; do
      [ -f "$f" ] || continue
      name="$(basename "$f" .pid)"
      if bg_stop "$name" "$(server_port_of "$name")" "$dir"; then log "$name stopped (${dir%/qa/runs/.lab})"
      else log "$name: stale pidfile removed, nothing stopped (${dir%/qa/runs/.lab})"; fi
    done
  done < <(linked_worktree_state_dirs)
}

cmd_status() {
  local servers
  log "devices:"; [ -f "$DEVICES_JSON" ] && jq -r '.[] | "  \(.label)\t\(.id)\t\(.model)"' "$DEVICES_JSON" || echo "  (none — run up)"
  log "lab servers by port (this checkout first, then its git worktrees):"
  servers="$(servers_status)"; echo "${servers:-  (none)}"
  if bg_running metro; then log "metro: running"; else log "metro: stopped"; fi
}

# Sourced (tests): define functions only
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0
c=${1:-help}; shift || true
case $c in
  doctor|setup|up|down|status|server|metro|photos|build|install|open|shot|play) "cmd_$c" "$@";;
  bots) node "$QA/lab/bots.mjs" "$@";;
  *) sed -n '2,/^#   bots/p' "$0";;
esac
