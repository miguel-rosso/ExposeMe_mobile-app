#!/usr/bin/env bash
# Step budget of the Maestro flows inside the server's timed phases (EXP-238, EXP-257, EXP-267, EXP-312). On a slow
# Android emulator every step that reads the screen takes 1-4 s, while the options are up for 8.5 s (answering) + 3 s
# (reveal) and the scoreboard for 5 s, so the steps between `# ── timed: <phase> ──` and `# ── end timed ──` must be few
# and cheap: no settle waits, no conditional reads (a `runFlow` whose `when` is only a `true:` script reads nothing),
# no text search (a testID filtered by an env variable, like `text: "${USERNAME}"`, is no UI string and is allowed).
# Then play-rounds.yaml's scoreboard deadline is checked against GameEngine.ts, and the flow is played on a fake game
# with slow screen reads (maestro-sim.mjs, scenario `rounds`). No devices, servers or network.
# Run: qa/lab/tests/maestro-timing.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="${MAESTRO_DIR:-$HERE/../../maestro}"
CLIENT_APP="$HERE/../../../Client/app"
GAME_ENGINE="$HERE/../../../Server/managers/GameEngine.ts"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# Steps that touch the device allowed per timed block (evalScript, assertTrue and a script-only `when` are free: they
# never read the screen). Scores: the card wait plus two checks of the scoreboard (EXP-141 no options under it, EXP-290
# the card never shows my own name), each started only while the scoreboard can still be up (EXP-312)
budget() { case $1 in answering) echo 3;; scores) echo 3;; *) echo "";; esac; }
# Longest settle wait after a tap or swipe in a timed block: the progress bar never settles, so the default waits it out
MAX_SETTLE_MS=500
# Slowest screen read seen on the Android emulator (12 players): the worst case of one budgeted step
SLOW_STEP_MS=4000

# ── Checker ──
# timed_blocks FLOW -> one line per timed block: "BLOCK <phase> <line> <steps> <first command or ->", "ERR <line>:
# <message>" for each rule a step breaks and "WARN <line>: <message>" for optional steps
timed_blocks() {
  awk -v max_settle="$MAX_SETTLE_MS" '
    function err_at(line, msg) { print "ERR " line ": " msg }
    function err(msg) { err_at(NR, msg) }
    function warn(msg) { print "WARN " NR ": " msg }
    function close_step() { # settle rules are reported on the line of the step
      if (cmd == "tapOn" || cmd == "swipe") {
        if (settle == "") err_at(step_line, cmd " without waitToSettleTimeoutMs (the default settle wait outlasts the phase)")
        else if (settle + 0 > max_settle) err_at(step_line, cmd " settles for " settle " ms (max " max_settle ")")
      }
      cmd = ""; settle = ""
    }
    function close_block() {
      close_step()
      print "BLOCK " phase " " start " " steps " " (first == "" ? "-" : first)
      phase = ""
    }
    /^[ \t]*# ── timed: / {
      if (phase != "") err("timed block opened inside another (from line " start ")")
      phase = $0; sub(/.*timed: /, "", phase); sub(/ .*/, "", phase)
      start = NR; steps = 0; first = ""; cmd = ""; settle = ""; when_indent = 0
      next
    }
    /^[ \t]*# ── end timed ──/ {
      if (phase == "") err("end timed without an open block"); else close_block()
      next
    }
    phase == "" || /^[ \t]*#/ { next }
    when_indent && match($0, /[^ \t]/) <= when_indent { when_indent = 0 }
    when_indent && /^[ \t]*(visible|notVisible|platform):/ {
      err_at(when_line, "conditional step reading the screen inside a timed phase (a false condition costs up to 7 s; only `true:` scripts)")
    }
    /^[ \t]*- [A-Za-z]+(:|$)/ {
      close_step()
      cmd = $0; sub(/^[ \t]*- /, "", cmd); sub(/:.*/, "", cmd); step_line = NR
      if (cmd == "evalScript" || cmd == "assertTrue") { cmd = ""; next } # JS only: no screen read
      # A runFlow reads nothing itself (its `when` may only be a script) and its own steps are counted, unless it runs a file
      if (cmd == "runFlow") {
        if ($0 ~ /runFlow:[ \t]*[^ \t#]/) err("runFlow of a subflow file inside a timed phase (it hides its steps)")
        cmd = ""; next
      }
      steps++
      if (first == "") first = cmd
      if (cmd ~ /^(waitForAnimationToEnd|scrollUntilVisible|repeat|retry)$/)
        err(cmd " inside a timed phase (it waits for the screen to settle, polls or hides more steps)")
      if (cmd == "assertNotVisible")
        err("assertNotVisible inside a timed phase (it polls until the element goes away: use extendedWaitUntil notVisible with a short timeout)")
    }
    /^[ \t]*(- )?(tapOn|assertVisible|assertNotVisible|visible|notVisible|from|scrollUntilVisible):[ \t]*[^ \t{#]/ {
      err("inline text selector inside a timed phase (use a testID)")
    }
    /^[ \t]*optional:[ \t]*true/ { warn("optional step inside a timed phase (a missing element costs up to 7 s)") }
    /^[ \t]*id:/ { id_line = NR; id_indent = match($0, /[^ \t]/) }
    /^[ \t]*text:/ {
      env_filter = $0 ~ /^[ \t]*text:[ \t]*"\$\{[A-Z_]+\}"[ \t]*$/
      if (!(env_filter && id_line == NR - 1 && id_indent == match($0, /[^ \t]/)))
        err("text selector inside a timed phase (use a testID, filtered at most by an env variable)")
    }
    /^[ \t]*when:/ { when_line = NR; when_indent = match($0, /[^ \t]/) }
    /^[ \t]*waitToSettleTimeoutMs:/ { settle = $2 }
    END { if (phase != "") { err("timed block from line " start " never closed"); close_block() } }
  ' "$1"
}

# check_flow FLOW -> ok/ko for every timed block of the flow; prints the number of blocks
check_flow() {
  local flow=$1 name; name="$(basename "$flow")"
  timed_blocks "$flow" >"$TMP/blocks"
  while read -r tag rest; do
    [ "$tag" = ERR ] && ko "$name: $rest"
    [ "$tag" = WARN ] && echo "warn - $name: $rest"
  done <"$TMP/blocks"
  while read -r tag phase line steps _; do
    [ "$tag" = BLOCK ] || continue
    local max; max="$(budget "$phase")"
    if [ -z "$max" ]; then ko "$name:$line: unknown timed phase '$phase'"
    elif [ "$steps" -le "$max" ]; then ok "$name:$line: $phase block takes $steps steps (budget $max)"
    else ko "$name:$line: $phase block takes $steps steps" "budget $max"; fi
  done <"$TMP/blocks"
}

engine_ms() { # CONSTANT -> its value in ms, from GameEngine.ts (e.g. "export const ANSWER_TIME = 8_500;")
  grep -E "^(export )?const $1 = [0-9_]+;" "$GAME_ENGINE" | sed -E 's/.*= ([0-9_]+);.*/\1/' | tr -d _
}

# ── The checker catches the slow patterns (fixture flows) ──
cat >"$TMP/slow.yaml" <<'EOF'
- repeat:
    commands:
      # ── timed: answering ──
      - tapOn:
          id: "player-option-bot1"
      - tapOn: "bot2"
      - runFlow:
          when:
            visible:
              id: "score-modal"
          commands:
            - assertVisible:
                id: "score-answer-card"
                text: "bot1"
      - waitForAnimationToEnd:
          timeout: 4000
      - assertNotVisible:
          id: "player-option-.*"
      - extendedWaitUntil:
          visible: "Round 1"
          timeout: 1000
      - swipe:
          from: "Bot 1"
          direction: UP
          waitToSettleTimeoutMs: 500
      - tapOn:
          id: "player-option-bot3"
          optional: true
          waitToSettleTimeoutMs: 500
      # ── end timed ──
EOF
timed_blocks "$TMP/slow.yaml" >"$TMP/slow.out"
for rule in "ERR 4: tapOn without waitToSettleTimeoutMs" "ERR 6: tapOn without waitToSettleTimeoutMs" "ERR 6: inline text selector" \
  "ERR 8: conditional step reading the screen" "ERR 14: text selector" "ERR 15: waitForAnimationToEnd inside" \
  "ERR 17: assertNotVisible inside" "ERR 20: inline text selector" "ERR 23: inline text selector" "WARN 28: optional step"; do
  grep -q "^$rule" "$TMP/slow.out" && ok "checker flags: $rule" || ko "checker flags: $rule" "$(cat "$TMP/slow.out")"
done
[ "$(grep -c '^ERR' "$TMP/slow.out")" = 9 ] && ok "checker reports every broken rule once (9)" || ko "checker reports every broken rule once" "$(cat "$TMP/slow.out")"
grep -q "^BLOCK answering [0-9]* 8 tapOn$" "$TMP/slow.out" \
  && ok "checker counts nested steps, not the runFlow around them (8)" || ko "checker counts nested steps" "$(cat "$TMP/slow.out")"
# A runFlow whose only condition is a script reads nothing (EXP-312); a subflow file or a screen condition does
cat >"$TMP/script-when.yaml" <<'EOF'
# ── timed: scores ──
- runFlow:
    when:
      true: ${Date.now() < output.deadline}
    commands:
      - extendedWaitUntil:
          visible:
            id: "score-answer-card"
          timeout: 1000
- runFlow: other.yaml
- runFlow:
    when:
      platform: Android
    commands:
      - extendedWaitUntil:
          notVisible:
            id: "player-option-.*"
          timeout: 1000
# ── end timed ──
EOF
timed_blocks "$TMP/script-when.yaml" >"$TMP/script-when.out"
! grep -qE "^ERR [2-9]:" "$TMP/script-when.out" && grep -q "^BLOCK scores 1 2 extendedWaitUntil$" "$TMP/script-when.out" \
  && ok "checker allows a runFlow conditioned on a script only, counting its steps" \
  || ko "checker allows a script-only runFlow" "$(cat "$TMP/script-when.out")"
grep -q "^ERR 10: runFlow of a subflow file" "$TMP/script-when.out" && grep -q "^ERR 12: conditional step reading the screen" "$TMP/script-when.out" \
  && ok "checker flags a subflow file and a platform condition" || ko "checker flags a subflow file and a platform condition" "$(cat "$TMP/script-when.out")"
( check_flow "$TMP/slow.yaml" ) >"$TMP/out" 2>&1 # subshell: its expected failures must not count
grep -q "^warn - slow.yaml: 28: optional step" "$TMP/out" && ok "optional steps are a warning" || ko "optional steps are a warning" "$(cat "$TMP/out")"
cat >"$TMP/settle.yaml" <<'EOF'
# ── timed: scores ──
- swipe:
    from:
      id: "answer-options"
    direction: UP
    waitToSettleTimeoutMs: 3000
- evalScript: ${output.n = 1}
- assertTrue: ${output.n}
# ── end timed ──
# ── timed: reveal ──
# ── end timed ──
EOF
timed_blocks "$TMP/settle.yaml" | grep -q "swipe settles for 3000 ms" && ok "checker flags a long settle wait" || ko "checker flags a long settle wait"
timed_blocks "$TMP/settle.yaml" | grep -q "^BLOCK scores [0-9]* 1 swipe$" && ok "evalScript and assertTrue are not counted" || ko "evalScript and assertTrue are not counted"
( check_flow "$TMP/settle.yaml" ) >"$TMP/out" 2>&1 # subshell: its expected failures must not count
grep -q "unknown timed phase 'reveal'" "$TMP/out" && ok "checker rejects a phase with no budget" || ko "checker rejects a phase with no budget" "$(cat "$TMP/out")"
printf -- '# ── timed: answering ──\n- tapOn:\n    id: "x"\n    waitToSettleTimeoutMs: 500\n' >"$TMP/open.yaml"
timed_blocks "$TMP/open.yaml" | grep -q "never closed" && ok "checker flags an unclosed block" || ko "checker flags an unclosed block"
cat >"$TMP/env-text.yaml" <<'EOF'
# ── timed: scores ──
- extendedWaitUntil:
    notVisible:
      id: "score-answer-name"
      text: "${USERNAME}"
    timeout: 1000
- extendedWaitUntil:
    notVisible:
      text: "${USERNAME}"
    timeout: 1000
- extendedWaitUntil:
    notVisible:
      id: "score-answer-name"
      text: "It was your photo!"
    timeout: 1000
# ── end timed ──
EOF
timed_blocks "$TMP/env-text.yaml" >"$TMP/env-text.out"
! grep -q "^ERR 5:" "$TMP/env-text.out" && ok "checker allows a testID filtered by an env variable" \
  || ko "checker allows a testID filtered by an env variable" "$(cat "$TMP/env-text.out")"
grep -q "^ERR 9: text selector" "$TMP/env-text.out" && ok "checker flags an env variable text without a testID" \
  || ko "checker flags an env variable text without a testID" "$(cat "$TMP/env-text.out")"
grep -q "^ERR 14: text selector" "$TMP/env-text.out" && ok "checker flags a UI string filter on a testID" \
  || ko "checker flags a UI string filter on a testID" "$(cat "$TMP/env-text.out")"

# ── Every flow's timed blocks fit their budget ──
for flow in "$MAESTRO_DIR"/*.yaml; do check_flow "$flow"; done

# ── The round flows mark their timed phases ──
blocks_of() { timed_blocks "$MAESTRO_DIR/$1" | grep -c "^BLOCK $2 "; } # FLOW, phase -> number of blocks
[ "$(blocks_of play-rounds.yaml answering)" = 1 ] && [ "$(blocks_of play-rounds.yaml scores)" = 1 ] \
  && ok "play-rounds.yaml budgets its answering and scores steps" || ko "play-rounds.yaml has answering + scores blocks"
[ "$(blocks_of many-players.yaml answering)" = 2 ] \
  && ok "many-players.yaml splits its checks over two answering phases" || ko "many-players.yaml has 2 answering blocks"

# ── play-rounds.yaml's scoreboard bounds fit the server's phases (EXP-267, EXP-312) ──
ROUNDS="$MAESTRO_DIR/play-rounds.yaml"
answer="$(engine_ms ANSWER_TIME)" reveal="$(engine_ms REVEAL_TIME)" scores="$(engine_ms SCORE_DISPLAY_TIME)"
# The flow's own copy: `- evalScript: "${output.timing = { answeringMs: 8500, ... }}"`
flow_timing="$(sed -nE 's/^- evalScript: "\$\{output\.timing = \{ (.*) \}\}"$/\1/p' "$ROUNDS")"
flow_ms() { tr ',' '\n' <<<"$flow_timing" | sed -nE "s/^ *$1: ([0-9]+) *$/\1/p"; } # KEY -> its value in the flow
# flow_has LINE: exit 0 if the flow has that exact line (leading spaces aside)
flow_has() { sed -E 's/^[[:space:]]*//' "$ROUNDS" | grep -qxF -- "$1"; }
if [ -z "$answer" ] || [ -z "$reveal" ] || [ -z "$scores" ]; then
  ko "phase durations read from GameEngine.ts" "answer=$answer reveal=$reveal scores=$scores"
else
  [ "$(flow_ms answeringMs)" = "$answer" ] && [ "$(flow_ms revealMs)" = "$reveal" ] && [ "$(flow_ms scoresMs)" = "$scores" ] \
    && ok "play-rounds.yaml's phase lengths match GameEngine.ts ($answer/$reveal/$scores ms)" \
    || ko "play-rounds.yaml's phase lengths match GameEngine.ts" "flow: $flow_timing"
  # The scoreboard closes the three phases after the options showed: after the last look that found none
  # (closesAfter), before the options were seen (closesBy). The card wait ends at closesBy: with the options seen at the
  # latest one slow read after they showed, that comes before the next round's scoreboard, so a missing card fails on
  # its own round instead of passing on a later one. readMs: how long the look that saw them took
  # shellcheck disable=SC2016 # Maestro expressions, not shell ones
  flow_has '- evalScript: ${output.timing.roundMs = output.timing.answeringMs + output.timing.revealMs + output.timing.scoresMs}' \
    && flow_has '- evalScript: "${output.round = { closesAfter: output.options.hiddenFrom && output.options.hiddenFrom + output.timing.roundMs, closesBy: output.options.seenAt + output.timing.roundMs, readMs: output.options.seenAt - output.options.lookFrom }}"' \
    && flow_has 'timeout: ${output.round.closesBy - Date.now()}' \
    && [ $((answer + reveal + scores + SLOW_STEP_MS)) -lt $((answer + reveal + scores + answer + reveal)) ] \
    && ok "the card wait ends when the scoreboard has surely closed, before the next one opens" \
    || ko "closesAfter/closesBy from the options wait, card wait until closesBy"
  # Every scoreboard step starts only before closesAfter, the card wait half a read before it (it fails if its first
  # read sees the next round); lab.sh counts the passes of that guard (lab-play.test.sh keeps them in sync)
  card_guard="true: $(sed -nE "s/^SCOREBOARD_GUARD='(.*)'$/\1/p" "$HERE/../lab.sh")"
  # shellcheck disable=SC2016
  check_guard='true: ${Date.now() < output.round.closesAfter}'
  guards="$(awk -v card="$card_guard" -v check="$check_guard" '/# ── timed: scores ──/ { on = 1 } /# ── end timed ──/ { on = 0 }
    { line = $0; sub(/^[ \t]*/, "", line) } on && (line == card || line == check) { n++ } END { print n + 0 }' "$ROUNDS")"
  read -r _ _ _ score_steps _ < <(timed_blocks "$ROUNDS" | grep "^BLOCK scores ")
  flow_has "$card_guard" && [ "$guards" = "${score_steps:-x}" ] \
    && ok "each of the $score_steps scoreboard steps starts only before the scoreboard may close" \
    || ko "every scoreboard step guarded by closesAfter" "guards=$guards steps=${score_steps:-}"
fi

# ── play-rounds.yaml on a fake game with slow screen reads (EXP-312) ──
# Every guess lands while answering, no scoreboard check passes after its scoreboard closed, slower phones (fixed and
# seeded random reads) never fail by mistake and lose few guesses, a missing card or the device's own name on it still
# fails (maestro-sim.mjs: Maestro 2.11 semantics, phase lengths from GameEngine.ts)
if out="$(node "$HERE/maestro-sim.mjs" rounds "$ROUNDS" "$CLIENT_APP" 2>&1)"; then
  while IFS=$'\t' read -r name verdict detail; do
    [ "$verdict" = ok ] && ok "play-rounds.yaml: $name" || ko "play-rounds.yaml: $name" "$detail"
  done <<<"$out"
else
  ko "play-rounds.yaml: the simulator runs the flow" "$(tr '\n' ' ' <<<"$out")"
fi

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
