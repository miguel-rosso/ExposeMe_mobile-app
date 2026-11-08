#!/usr/bin/env bash
# `lab.sh server --stop/--restart`, bg_stop and `status` with parallel lab servers (EXP-067): a checkout only ever
# stops the processes its own pidfile names, never whatever listens on the port (the shared :3000 seen from a git
# worktree, another agent's server). Uses throwaway TCP listeners on free ports: no real lab server, devices or network.
# Run: qa/lab/tests/lab-server.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
SPAWNED=()   # pids of the processes this test started, killed on exit whatever happens
cleanup() { [ ${#SPAWNED[@]} = 0 ] || builtin kill -9 "${SPAWNED[@]}" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# shellcheck source=../lab.sh
source "$HERE/../lab.sh"
set +e

# ── Fake environment: a main checkout with one git worktree, each with its own lab state ──
ROOT="$TMP/main"; RUNS="$ROOT/qa/runs"; STATE="$RUNS/.lab"; DEVICES_JSON="$STATE/devices.json"; mkdir -p "$STATE"
git -C "$ROOT" init -q && git -C "$ROOT" -c user.name=lab -c user.email=lab@test commit -q --allow-empty -m init
WT="$TMP/worktree"; git -C "$ROOT" worktree add -q "$WT" 2>/dev/null; mkdir -p "$WT/qa/runs/.lab"
BG_STOP_GRACE_TICKS=10

free_port() { node -e 's=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
LISTEN_JS='require("net").createServer().listen(+process.argv[1])'
wait_listening() { # port: exit 0 once something listens on it (up to ~5 s)
  for _ in $(seq 1 50); do [ -n "$(port_listeners "$1")" ] && return 0; sleep 0.1; done; return 1
}
alive() { builtin kill -0 "$1" 2>/dev/null; }
foreign_listener() { # port: a listener no lab pidfile knows about (the shared :3000 from a worktree's point of view)
  node -e "$LISTEN_JS" "$1" & FOREIGN=$!; SPAWNED+=("$FOREIGN"); wait_listening "$1"
}
lab_like() { # name, [cwd]: starts a process whose command line looks like that lab process (server, metro); sets LAB_LIKE
  (cd "${2:-.}" && exec bash -c "sleep 30; : $(bg_command_of "$1")") & LAB_LIKE=$!; SPAWNED+=("$LAB_LIKE")
  for _ in $(seq 1 50); do bg_pid_is "$LAB_LIKE" "$1" && return 0; sleep 0.1; done; return 1
}
TAB=$'\t'   # servers_status separates the port from the state with a tab
run_server() { out="$( (set -euo pipefail; cmd_server "$@") 2>&1)"; rc=$?; } # sets out, rc

P_OWN="$(free_port)"; P_SHARED="$(free_port)"
SERVER_PORT=$P_SHARED   # this test's stand-in for the shared :3000

# ── bg_stop: stops the whole process tree its pidfile names (npx → node), and frees the port ──
# `; :` keeps bash from exec'ing node, so the listener is a grandchild of the recorded pid like npx's server, and puts
# the server's command (bg_command_of) in the recorded process's command line
bg_start "server-$P_OWN" "$RUNS/server-$P_OWN.log" "$TMP" bash -c "node -e '$LISTEN_JS' $P_OWN; : ts-node server.ts" >/dev/null
OWN_PID="$(cat "$STATE/server-$P_OWN.pid")"; SPAWNED+=("$OWN_PID")
wait_listening "$P_OWN" || ko "own server listens"
bg_running "server-$P_OWN" && ok "bg_running: pidfile names a live lab server" || ko "bg_running own server"
tree="$(process_tree "$OWN_PID" | tr '\n' ' ')"
[ "$(wc -w <<<"$tree")" -ge 2 ] && ok "process_tree: the wrapper and its node child" || ko "process_tree" "$tree"
SPAWNED+=($tree)
run_server --stop --port "$P_OWN"
dead=1; for p in $tree; do alive "$p" && dead=0; done
[ $rc = 0 ] && [ $dead = 1 ] && [ -z "$(port_listeners "$P_OWN")" ] && [ ! -e "$STATE/server-$P_OWN.pid" ] \
  && ok "server --stop --port: own server's whole tree stopped, port free, pidfile gone" || ko "own server stopped" "rc=$rc $out"

# ── The port belongs to someone else: never killed (the shared :3000 seen from a worktree) ──
foreign_listener "$P_SHARED" || ko "foreign listener up"
run_server --stop --port "$P_SHARED"
alive "$FOREIGN" && ok "server --stop --port <shared> without its pidfile -> shared server left running" \
  || ko "server --stop must not kill a server it didn't start" "$out"
grep -q "port :$P_SHARED is still in use by pid(s) $FOREIGN.*didn't start" <<<"$out" \
  && ok "  ... and says which pid still holds the port" || ko "warning names the foreign pid" "$out"

out="$( (set -euo pipefail; bg_stop server "$P_SHARED") 2>&1)"
alive "$FOREIGN" && ok "bg_stop (lab.sh down) without a pidfile -> shared server left running" || ko "bg_stop kills by port"

run_server --stop
[ $rc != 0 ] && grep -q "server --stop needs the port it stops: --port N (--port $P_SHARED" <<<"$out" && alive "$FOREIGN" \
  && ok "server --stop without --port -> refused, nothing stopped" || ko "--stop without --port refused" "rc=$rc $out"

run_server --restart
[ $rc != 0 ] && grep -q "port :$P_SHARED is already in use by pid(s) $FOREIGN" <<<"$out" && alive "$FOREIGN" \
  && [ ! -e "$STATE/server.pid" ] && ! grep -q "healthy" <<<"$out" \
  && ok "server --restart (default port) from a checkout that didn't start it -> refused, shared server untouched" \
  || ko "--restart without --port touches only this checkout's server" "rc=$rc $out"
grep -q "Check it: ps -p $FOREIGN;.*orphaned lab process.*kill $FOREIGN" <<<"$out" \
  && ok "  ... from the main checkout: says how to check the pid and stop an orphaned lab server" || ko "main checkout hint" "$out"
out="$( (set -euo pipefail; ROOT="$WT"; STATE="$WT/qa/runs/.lab"; cmd_server --restart) 2>&1)"
grep -q "which this worktree didn't start (the main checkout's lab?). Run your own: server --port N" <<<"$out" && alive "$FOREIGN" \
  && ok "  ... from a worktree: points at the main checkout's lab and --port" || ko "worktree hint" "$out"

# ── A pidfile whose pid now runs something else (pid reused) is stale: never killed ──
echo "$FOREIGN" >"$STATE/server.pid"
bg_running server && ko "bg_running: pid that isn't a lab server" || ok "bg_running: pidfile pid running something else -> not running"
run_server --restart
[ $rc != 0 ] && alive "$FOREIGN" && [ ! -e "$STATE/server.pid" ] \
  && grep -q "stale server pidfile: pid $FOREIGN is gone or no longer runs 'ts-node server.ts', removed without killing it" <<<"$out" \
  && ok "server --restart with a reused pid in the pidfile -> warns, removes it, kills nothing" || ko "reused pid not killed" "rc=$rc $out"

# ── metro: a Metro this checkout didn't start must not pass as 'metro ready' ──
METRO_PORT=$P_SHARED   # the foreign listener stands in for a non-QA Metro
metro_run() { # args: cmd_metro with a client_path stub that marks how far it got; sets out, rc
  out="$( (set -euo pipefail; client_path() { echo "client_path reached" >&2; return 1; }; cmd_metro "$@") 2>&1)"; rc=$?
}
metro_run
[ $rc != 0 ] && grep -q "port :$P_SHARED is already in use by pid(s) $FOREIGN" <<<"$out" \
  && ! grep -q "client_path reached\|metro ready" <<<"$out" && alive "$FOREIGN" && [ ! -e "$STATE/metro.pid" ] \
  && ok "metro: port held by a Metro it didn't start -> refused before starting" || ko "metro port guard" "rc=$rc $out"
echo "$FOREIGN" >"$STATE/metro.pid"; metro_run --restart
[ $rc != 0 ] && alive "$FOREIGN" && grep -q "stale metro pidfile.*'expo start'" <<<"$out" && grep -q "already in use" <<<"$out" \
  && ok "metro --restart with a reused pid -> nothing killed, still refused" || ko "metro --restart reused pid" "rc=$rc $out"
lab_like metro || ko "lab-like metro up"; echo "$LAB_LIKE" >"$STATE/metro.pid"
metro_run
grep -q "client_path reached" <<<"$out" && ! grep -q "already in use" <<<"$out" \
  && ok "metro: its own Metro running -> no port guard" || ko "own metro passes the guard" "rc=$rc $out"
rm -f "$STATE/metro.pid"

# A stale pidfile (its process is gone) still only stops its own pid, never the port's listener
sh -c 'echo $$' >"$STATE/server.pid"   # the pid of a process that already exited
out="$( (set -euo pipefail; bg_stop server "$P_SHARED") 2>&1)"
alive "$FOREIGN" && [ ! -e "$STATE/server.pid" ] && ok "stale pidfile -> removed, the port's listener untouched" \
  || ko "stale pidfile" "$out"

# ── status: every lab server by port, this checkout's and the worktrees' ──
lab_like server || ko "lab-like server up"; mine=$LAB_LIKE; echo "$mine" >"$STATE/server.pid"
lab_like server-4101 || ko "lab-like worktree server up"; theirs=$LAB_LIKE; echo "$theirs" >"$WT/qa/runs/.lab/server-4101.pid"
echo 99999999 >"$WT/qa/runs/.lab/server-4102.pid"
echo "$FOREIGN" >"$WT/qa/runs/.lab/server-4103.pid"
out="$( (set -euo pipefail; cmd_status) 2>&1)"
grep -q "^  :$P_SHARED${TAB}running (pid $mine)$" <<<"$out" && ok "status: this checkout's :default server by port" || ko "status: own server" "$out"
grep -q "^  :4101${TAB}running (pid $theirs)  ($WT)$" <<<"$out" && ok "status: a worktree's server by port, with its checkout" \
  || ko "status: worktree server" "$out"
grep -q "^  :4102${TAB}stopped (stale pidfile)  ($WT)$" <<<"$out" && ok "status: a dead worktree server shows as stopped" \
  || ko "status: stale worktree pidfile" "$out"
grep -q "^  :4103${TAB}stopped (stale pidfile)  ($WT)$" <<<"$out" && ok "status: a pidfile whose pid runs something else -> stopped" \
  || ko "status: reused pid" "$out"
# Seen from the worktree, the main checkout's server is listed with its checkout
out="$( (set -euo pipefail; ROOT="$WT"; STATE="$WT/qa/runs/.lab"; cmd_status) 2>&1)"
grep -q "^  :4101${TAB}running (pid $theirs)$" <<<"$out" && grep -q "^  :$P_SHARED${TAB}running (pid $mine)  ($ROOT)$" <<<"$out" \
  && ok "status from a worktree: own server first, the main checkout's with its path" || ko "status from a worktree" "$out"
rm -f "$STATE"/server*.pid "$WT"/qa/runs/.lab/server*.pid
out="$( (set -euo pipefail; cmd_status) 2>&1)"
grep -q "^  (none)$" <<<"$out" && grep -q "metro: stopped" <<<"$out" && ok "status: no lab server -> (none)" || ko "status: none" "$out"

# ── down --worktrees: also stops the servers the worktrees started, through their own pidfiles (EXP-279) ──
# A worktree's server runs in its Server dir (bg_start's cwd); a pidfile whose pid now runs another session's lab-like
# process (pid reuse) elsewhere must not be followed, unless that process serves the pidfile's port
run_down() { out="$( (set -euo pipefail; cmd_down "$@") 2>&1)"; rc=$?; } # sets out, rc
gone_soon() { for _ in $(seq 1 25); do alive "$1" || return 0; sleep 0.2; done; return 1; } # pid: exit 0 once it exited
mkdir -p "$WT/Server" "$TMP/elsewhere"
lab_like server-4101 "$WT/Server" || ko "lab-like worktree server up"; theirs=$LAB_LIKE
echo "$theirs" >"$WT/qa/runs/.lab/server-4101.pid"
lab_like server "$WT/Server" || ko "lab-like worktree default-port server up"; theirs_default=$LAB_LIKE
echo "$theirs_default" >"$WT/qa/runs/.lab/server.pid"
lab_like server-4103 "$TMP/elsewhere" || ko "another session's lab-like server up"; reused=$LAB_LIKE
echo "$reused" >"$WT/qa/runs/.lab/server-4103.pid"   # stale pidfile, its pid reused by another session's server
P_SERVED="$(free_port)"   # started elsewhere, but serving the pidfile's port: the worktree's server all the same
bg_start "server-$P_SERVED" "$TMP/served.log" "$TMP/elsewhere" bash -c "node -e '$LISTEN_JS' $P_SERVED; : ts-node server.ts" >/dev/null
served="$(cat "$STATE/server-$P_SERVED.pid")"; SPAWNED+=("$served"); mv "$STATE/server-$P_SERVED.pid" "$WT/qa/runs/.lab/"
wait_listening "$P_SERVED" || ko "worktree server serving its port up"
lab_like server-4200 || ko "lab-like main checkout server up"; mine=$LAB_LIKE; echo "$mine" >"$STATE/server-4200.pid"
run_down
[ $rc = 0 ] && alive "$theirs" && [ -f "$WT/qa/runs/.lab/server-4101.pid" ] \
  && ok "down without --worktrees: the worktrees' servers keep running" || ko "plain down leaves worktree servers" "rc=$rc $out"
run_down --worktrees
gone_soon "$theirs" && gone_soon "$theirs_default" && [ ! -e "$WT/qa/runs/.lab/server-4101.pid" ] \
  && [ ! -e "$WT/qa/runs/.lab/server.pid" ] && [ $rc = 0 ] \
  && ok "down --worktrees: every worktree server stopped through its pidfile, pidfiles removed" || ko "down --worktrees stops worktree servers" "rc=$rc $out"
grep -q "server-4101 stopped ($WT)" <<<"$out" && ok "  ... and says which worktree each stopped server belonged to" || ko "down --worktrees log" "$out"
gone_soon "$served" && [ -z "$(port_listeners "$P_SERVED")" ] && grep -q "server-$P_SERVED stopped ($WT)" <<<"$out" \
  && ok "  ... a server running elsewhere but serving its pidfile's port is stopped too" || ko "down --worktrees: port-serving server" "$out"
alive "$reused" && [ ! -e "$WT/qa/runs/.lab/server-4103.pid" ] \
  && grep -q "stale server-4103 pidfile of $WT: pid $reused is gone or no longer runs 'ts-node server.ts' from that checkout, removed without killing it" <<<"$out" \
  && grep -q "server-4103: stale pidfile removed, nothing stopped ($WT)" <<<"$out" && ! grep -q "server-4103 stopped" <<<"$out" \
  && ok "  ... a stale pidfile whose pid now runs another session's server elsewhere: removed, that server left running" \
  || ko "down --worktrees: reused pid not killed" "$out"
alive "$FOREIGN" && alive "$mine" \
  && ok "  ... the shared port's foreign listener and the main checkout's other servers left running" || ko "down --worktrees kills only worktree servers" "$out"
lab_like server-4102 "$WT/Server" || ko "lab-like worktree server up"; theirs=$LAB_LIKE; echo "$theirs" >"$WT/qa/runs/.lab/server-4102.pid"
out="$( (set -euo pipefail; ROOT="$WT"; STATE="$WT/qa/runs/.lab"; cmd_down --worktrees) 2>&1)"; rc=$?
[ $rc != 0 ] && grep -q "down --worktrees runs from the main checkout only" <<<"$out" && alive "$theirs" && alive "$mine" \
  && ok "down --worktrees from a worktree -> refused before stopping anything" || ko "down --worktrees from a worktree" "rc=$rc $out"
run_down --bogus
[ $rc != 0 ] && grep -q "bad arg --bogus (usage: down \[--worktrees\])" <<<"$out" && ok "down: unknown option refused" || ko "down bad arg" "rc=$rc $out"
rm -f "$STATE"/server*.pid "$WT"/qa/runs/.lab/server*.pid

# ── server: the load-test limits are lifted, within the range the server accepts (EXP-260) ──
SERVER_SRC="$HERE/../../../Server"
server_env() { # [VAR=value...]: the VAR=value environment cmd_server starts the server with (nothing is started)
  ( set -euo pipefail; [ $# = 0 ] || export "$@"
    bg_running() { return 1; }; ensure_port_free() { :; }; curl() { return 0; }
    bg_start() { shift 3; printf '%s\n' "$@"; }   # name, log, cwd, then: env VAR=value... npx ts-node server.ts
    cmd_server --port 4999 ) 2>/dev/null | grep -E '^[A-Z][A-Z0-9_]*='   # names may hold digits (..._IPV6_...)
}
env_value() { sed -n "s/^$1=//p" <<<"$2"; } # VAR, environment
envint_args() { # VAR: "default|min|max" of the server's envInt() for it (digit separators dropped), empty if none
  grep -rhoE --include=*.ts --exclude-dir=node_modules --exclude-dir=tests "envInt\(\"$1\", [^)]*\)" "$SERVER_SRC" | head -1 \
    | sed -E 's/^envInt\("[A-Z_]+", (.*)\)$/\1/; s/([0-9])_([0-9])/\1\2/g; s/, /|/g'
}
is_int() { [[ $1 =~ ^[0-9]+$ ]]; }
env="$(server_env)"
for knob in SOCKET_HANDSHAKE_RATE_MAX UPLOAD_STORED_MAX UPLOAD_LOBBY_PER_IP_MAX SOCKET_MAX_CONNECTIONS_PER_IP \
  ROOMS_PER_IP_MAX ROOMS_PER_IPV6_PREFIX_MAX; do
  [ -n "$(env_value "$knob" "$env")" ] && ok "server: sets $knob for load tests" || ko "server sets $knob" "$env"
done
# The rooms-per-IP limits are bound by the server's room cap (envInt range 1..MAX_ROOMS, a constant the loop below
# can't read), so the lab's values may not exceed it
max_rooms="$(sed -nE 's/^export const MAX_ROOMS = ([0-9_]+);.*/\1/p' "$SERVER_SRC/managers/RoomManager.ts" | tr -d _)"
for knob in ROOMS_PER_IP_MAX ROOMS_PER_IPV6_PREFIX_MAX; do
  value="$(env_value "$knob" "$env")"
  is_int "$max_rooms" && is_int "$value" && [ "$value" -ge 1 ] && [ "$value" -le "$max_rooms" ] \
    && ok "server: $knob=$value within the server's room cap (1..$max_rooms)" \
    || ko "server: $knob within 1..MAX_ROOMS" "value '$value', MAX_ROOMS '$max_rooms'"
done
while IFS='=' read -r knob value; do
  IFS='|' read -r default min max <<<"$(envint_args "$knob")"
  [ -n "$max" ] || continue   # not a server limit (PORT, QA_TELEMETRY...)
  if is_int "$max" && [ "$value" -gt "$max" ]; then ko "server: $knob=$value within the server's max $max"
  elif is_int "$default" && [ "$value" -le "$default" ]; then ko "server: $knob=$value lifts the server's default $default"
  else ok "server: $knob=$value lifts the server default ($default) within its max ($max)"; fi
done <<<"$env"
[ "$(env_value UPLOAD_STORED_MAX "$(server_env UPLOAD_STORED_MAX=7)")" = 7 ] \
  && ok "server: a limit set in the environment overrides the lab's" || ko "server: env override of UPLOAD_STORED_MAX"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
