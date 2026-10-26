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
lab_like() { # name: starts a process whose command line looks like that lab process (server, metro); sets LAB_LIKE
  bash -c "sleep 30; : $(bg_command_of "$1")" & LAB_LIKE=$!; SPAWNED+=("$LAB_LIKE")
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

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
