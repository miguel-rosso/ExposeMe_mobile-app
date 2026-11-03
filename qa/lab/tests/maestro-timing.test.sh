#!/usr/bin/env bash
# Step budget of the Maestro flows inside the server's timed phases (EXP-238, EXP-257, EXP-267, EXP-312). On a slow
# Android emulator every step that reads the screen takes 1-4 s, while the options are up for 8.5 s (answering) + 3 s
# (reveal) and the scoreboard for 5 s, so the steps between `# ── timed: <phase> ──` and `# ── end timed ──` must be few
# and cheap: no settle waits, no conditional reads (a `runFlow` whose `when` is only a `true:` script reads nothing),
# no text search (a testID filtered by an env variable, like `text: "${USERNAME}"`, or by any text but one, like
# `text: "(?!${USERNAME}$).+"`, is no UI string, and one filtered by an app string in every language, `"<en>|<es>"` of
# one Client/src/i18n key, works in either: all are allowed).
# A poll loop (EXP-353: a `repeat` whose `while` is a script bound in time by Date.now(), holding only looks and
# assertTrue scripts) is one step: a wait like extendedWaitUntil that notes when each of its looks starts and ends.
# Then play-rounds.yaml's scoreboard deadline is checked against GameEngine.ts, and the flow is played on a fake game
# with slow screen reads (maestro-sim.mjs, scenario `rounds`); hold-used-up.yaml's copy of the hold times too (and the
# flow on a fake game of its own, scenario `hold`), and the
# kick-after-game flows' waits against the bots' kick delay (EXP-346). No devices, servers or network.
# Run: qa/lab/tests/maestro-timing.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="${MAESTRO_DIR:-$HERE/../../maestro}"
CLIENT_APP="$HERE/../../../Client/src"
GAME_ENGINE="$HERE/../../../Server/managers/GameEngine.ts"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# Steps that touch the device allowed per timed block (evalScript, assertTrue and a script-only `when` are free: they
# never read the screen). Scores: the card wait plus two checks of the scoreboard (EXP-141 no options under it, EXP-290
# the card never shows my own name) and the look that proves the card checked (EXP-350), each started only while the
# scoreboard can still be up (EXP-312)
budget() { case $1 in answering) echo 3;; scores) echo 4;; *) echo "";; esac; }
# Longest settle wait after a tap or swipe in a timed block: the progress bar never settles, so the default waits it out
MAX_SETTLE_MS=500
# Slowest screen read seen on the Android emulator (12 players): the worst case of one budgeted step
SLOW_STEP_MS=4000

# ── Checker ──
# i18n_pairs APP_DIR -> one "<en>|<es>" line per i18n key with a one-line string in both languages
i18n_pairs() {
  node -e '
    const fs = require("fs");
    const load = (f) => new Function(fs.readFileSync(f, "utf8").replace(/^export default/m, "return").replace(/\}\s*as const;\s*$/, "}"))();
    const [en, es] = process.argv.slice(1).map(load);
    const oneLine = (v) => typeof v === "string" && !v.includes("\n");
    for (const key of Object.keys(en)) if (oneLine(en[key]) && oneLine(es[key])) console.log(`${en[key]}|${es[key]}`);
  ' "$1/i18n/en.ts" "$1/i18n/es.ts"
}
# The translated filters the checker allows (I18N_PAIRS: a file of i18n_pairs lines; the fixtures' first, then the app's)
I18N_PAIRS="$TMP/i18n-pairs"

# timed_blocks FLOW -> one line per timed block: "BLOCK <phase> <line> <steps> <first command or ->", "ERR <line>:
# <message>" for each rule a step breaks and "WARN <line>: <message>" for optional steps
timed_blocks() {
  awk -v max_settle="$MAX_SETTLE_MS" -v pairs="$I18N_PAIRS" '
    BEGIN { while ((getline pair < pairs) > 0) translated[pair] = 1 }
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
    function close_poll() {
      if (!poll_while) err_at(poll_line, "poll loop without a `while:` script (a `times:` repeat hides its steps)")
      if (!poll_looks) err_at(poll_line, "poll loop without a look")
      poll_indent = 0
    }
    function close_block() {
      close_step()
      if (poll_indent) close_poll()
      print "BLOCK " phase " " start " " steps " " (first == "" ? "-" : first)
      phase = ""
    }
    /^[ \t]*# ── timed: / {
      if (phase != "") err("timed block opened inside another (from line " start ")")
      phase = $0; sub(/.*timed: /, "", phase); sub(/ .*/, "", phase)
      start = NR; steps = 0; first = ""; cmd = ""; settle = ""; when_indent = 0; poll_indent = 0; while_indent = 0
      next
    }
    /^[ \t]*# ── end timed ──/ {
      if (phase == "") err("end timed without an open block"); else close_block()
      next
    }
    phase == "" || /^[ \t]*#/ { next }
    poll_indent && match($0, /[^ \t]/) <= poll_indent { close_step(); close_poll() }
    when_indent && match($0, /[^ \t]/) <= when_indent { when_indent = 0 }
    while_indent && match($0, /[^ \t]/) <= while_indent { while_indent = 0 }
    while_indent && /^[ \t]*(visible|notVisible|platform):/ {
      err_at(while_line, "poll loop whose condition reads the screen (only a `true:` script: its looks read it)")
    }
    while_indent && /^[ \t]*true:/ {
      poll_while = 1
      if ($0 !~ /Date\.now\(\)/) err("poll loop whose `while` script is not bound in time (Date.now())")
    }
    when_indent && poll_indent && /^[ \t]*(visible|notVisible):/ { poll_looks++ }
    when_indent && poll_indent && /^[ \t]*platform:/ {
      err_at(when_line, "platform condition inside a poll loop (its looks must read the screen every pass)")
    }
    when_indent && !poll_indent && /^[ \t]*(visible|notVisible|platform):/ {
      err_at(when_line, "conditional step reading the screen inside a timed phase (a false condition costs up to 7 s; only `true:` scripts)")
    }
    /^[ \t]*- [A-Za-z]+(:|$)/ {
      close_step()
      cmd = $0; sub(/^[ \t]*- /, "", cmd); sub(/:.*/, "", cmd); step_line = NR
      if (poll_indent) { # its looks and their bookkeeping, which must not act on the device (looks would wait longer)
        if (cmd != "assertTrue" && !(cmd == "runFlow" && $0 !~ /runFlow:[ \t]*[^ \t#]/)) {
          err("only looks (an inline runFlow) and assertTrue scripts inside a poll loop, not " cmd)
        }
        cmd = ""; next
      }
      if (cmd == "evalScript" || cmd == "assertTrue") { cmd = ""; next } # JS only: no screen read
      if (cmd == "repeat") { # a poll loop: one step
        steps++; if (first == "") first = cmd
        poll_indent = match($0, /[^ \t]/); poll_line = NR; poll_while = 0; poll_looks = 0
        cmd = ""; next
      }
      # A runFlow reads nothing itself (its `when` may only be a script) and its own steps are counted, unless it runs a file
      if (cmd == "runFlow") {
        if ($0 ~ /runFlow:[ \t]*[^ \t#]/) err("runFlow of a subflow file inside a timed phase (it hides its steps)")
        cmd = ""; next
      }
      steps++
      if (first == "") first = cmd
      if (cmd ~ /^(waitForAnimationToEnd|scrollUntilVisible|retry)$/)
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
      env_filter = $0 ~ /^[ \t]*text:[ \t]*"(\$\{[A-Z_]+\}|\(\?!\$\{[A-Z_]+\}\$\)\.\+)"[ \t]*$/
      text = $0; sub(/^[ \t]*text:[ \t]*/, "", text); sub(/[ \t]+$/, "", text)
      if (text ~ /^".*"$/) text = substr(text, 2, length(text) - 2)
      if (!((env_filter || text in translated) && id_line == NR - 1 && id_indent == match($0, /[^ \t]/)))
        err("text selector inside a timed phase (use a testID, filtered at most by an env variable or an app string in every language)")
    }
    /^[ \t]*when:/ { when_line = NR; when_indent = match($0, /[^ \t]/) }
    poll_indent && /^[ \t]*while:/ { while_line = NR; while_indent = match($0, /[^ \t]/) }
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
# Fixture app strings: one key in both languages, one in English only and one on two lines
mkdir -p "$TMP/app/i18n"
printf 'export default {\n  noHoldsLeft: "No holds left",\n  english: "Only English",\n  twoLines: "A\\nB",\n} as const;\n' >"$TMP/app/i18n/en.ts"
printf 'export default {\n  noHoldsLeft: "Ya no puedes mantenerla",\n  twoLines: "C\\nD",\n} as const;\n' >"$TMP/app/i18n/es.ts"
i18n_pairs "$TMP/app" >"$I18N_PAIRS"
[ "$(cat "$I18N_PAIRS")" = "No holds left|Ya no puedes mantenerla" ] \
  && ok "checker reads the app strings both languages have on one line" || ko "checker reads i18n pairs" "$(cat "$I18N_PAIRS")"
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
- extendedWaitUntil:
    visible:
      id: "hold-button"
      text: "No holds left|Ya no puedes mantenerla"
      enabled: false
    timeout: 1000
- extendedWaitUntil:
    visible:
      text: "No holds left|Ya no puedes mantenerla"
    timeout: 1000
- extendedWaitUntil:
    visible:
      id: "hold-button"
      text: "No holds left|Ya no puedes"
    timeout: 1000
- extendedWaitUntil:
    visible:
      id: "score-answer-name"
      text: "(?!${USERNAME}$).+"
    timeout: 1000
- extendedWaitUntil:
    visible:
      id: "score-answer-name"
      text: "(?!Bot 1$).+"
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
! grep -q "^ERR 19:" "$TMP/env-text.out" && ok "checker allows a testID filtered by an app string in every language" \
  || ko "checker allows a testID filtered by an app string in every language" "$(cat "$TMP/env-text.out")"
! grep -q "^ERR 34:" "$TMP/env-text.out" && grep -q "^ERR 39: text selector" "$TMP/env-text.out" \
  && ok "checker allows a testID filtered by any text but an env variable's, not by any text but a UI string" \
  || ko "checker allows (?!\${VAR}\$).+ filters only" "$(cat "$TMP/env-text.out")"
grep -q "^ERR 24: text selector" "$TMP/env-text.out" && grep -q "^ERR 29: text selector" "$TMP/env-text.out" \
  && [ "$(grep -c '^ERR' "$TMP/env-text.out")" = 5 ] \
  && ok "checker flags an app string without a testID, and a filter that is not one key in every language" \
  || ko "checker flags translated filters without a testID or off the app strings" "$(cat "$TMP/env-text.out")"
# EXP-353: a poll loop of looks and assertTrue scripts is one step; anything else in it, a condition reading the screen
# in its `while`, a `while` not bound in time, no `while`, no look or a platform condition are flagged
cat >"$TMP/poll.yaml" <<'EOF'
# ── timed: scores ──
- repeat:
    while:
      true: ${!output.seen && Date.now() < output.deadline}
    commands:
      - runFlow:
          when:
            true: ${output.lookFrom = Date.now()}
            visible:
              id: "score-answer-card"
          commands:
            - assertTrue: ${output.seen = true}
      - assertTrue: ${output.seen || (output.missFrom = output.lookFrom)}
- extendedWaitUntil:
    notVisible:
      id: "score-answer-name"
    timeout: 1000
# ── end timed ──
# ── timed: answering ──
- repeat:
    while:
      visible:
        id: "player-option-.*"
    commands:
      - tapOn:
          id: "player-option-bot1"
          waitToSettleTimeoutMs: 500
      - evalScript: ${output.n = 1}
- repeat:
    times: 2
    commands:
      - assertTrue: ${output.n}
- repeat:
    while:
      true: ${!output.seen}
    commands:
      - runFlow:
          when:
            platform: Android
            visible:
              id: "score-answer-card"
          commands:
            - assertTrue: ${output.seen = true}
# ── end timed ──
EOF
timed_blocks "$TMP/poll.yaml" >"$TMP/poll.out"
! grep -qE "^ERR ([2-9]|1[0-9]):" "$TMP/poll.out" && grep -q "^BLOCK scores 1 2 repeat$" "$TMP/poll.out" \
  && ok "checker counts a poll loop of looks and assertTrue scripts as one step" \
  || ko "checker counts a poll loop as one step" "$(cat "$TMP/poll.out")"
for rule in "ERR 21: poll loop whose condition reads the screen" "ERR 25: only looks" "ERR 28: only looks" \
  "ERR 29: poll loop without a \`while:\` script" "ERR 29: poll loop without a look" \
  "ERR 35: poll loop whose \`while\` script is not bound in time" "ERR 38: platform condition inside a poll loop"; do
  grep -qF -- "$rule" "$TMP/poll.out" && ok "checker flags: $rule" || ko "checker flags: $rule" "$(cat "$TMP/poll.out")"
done

# ── Every flow's timed blocks fit their budget ──
i18n_pairs "$CLIENT_APP" >"$I18N_PAIRS"
grep -qxF "$(sed -nE 's/^  noHoldsLeft: "(.*)",$/\1/p' "$CLIENT_APP/i18n/en.ts")|$(sed -nE 's/^  noHoldsLeft: "(.*)",$/\1/p' "$CLIENT_APP/i18n/es.ts")" "$I18N_PAIRS" \
  && ok "app strings read from Client/src/i18n ($(wc -l <"$I18N_PAIRS" | tr -d ' ') in both languages)" \
  || ko "app strings read from Client/src/i18n" "$(head -3 "$I18N_PAIRS")"
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
  # EXP-325: a held scoreboard is waited out for the round's hold budget, and the next options a hold budget longer
  hold_budget="$(engine_ms HOLD_BUDGET_PER_ROUND)"
  # shellcheck disable=SC2016 # Maestro expressions, not shell ones
  [ -n "$hold_budget" ] && [ "$(flow_ms holdBudgetMs)" = "$hold_budget" ] \
    && flow_has 'timeout: ${output.timing.holdBudgetMs + output.timing.holdEndSlackMs}' \
    && grep -qF 'giveUpAt: output.round.closesBy + output.timing.holdBudgetMs + output.timing.optionsWaitMs' "$ROUNDS" \
    && ok "play-rounds.yaml waits out a hold for GameEngine.ts's hold budget ($hold_budget ms)" \
    || ko "play-rounds.yaml's hold budget matches GameEngine.ts" "engine: ${hold_budget:-none}, flow: $flow_timing"
  # EXP-326: between the lobby and round 1's first look for the options only scripts run (no screen read) and the round
  # loop's condition is a script, its game-over look ending each pass; that first wait for the options covers the game's
  # start (EXP-143: up to 180 s)
  steps_before_loop="$(awk '/^- runFlow: wait-game-start.yaml$/ { on = 1; next } /^- repeat:$/ { exit }
    on && /^- / { sub(/:.*/, ""); print }' "$ROUNDS" | sort -u | tr '\n' ' ')"
  # shellcheck disable=SC2016 # Maestro expressions, not shell ones
  [ "$steps_before_loop" = "- evalScript " ] \
    && flow_has 'true: ${output.game.playingFrom === output.game.lookFrom}' \
    && [ "$(flow_ms gameStartWaitMs)" -ge 180000 ] 2>/dev/null \
    && grep -qF 'giveUpAt: Date.now() + output.timing.gameStartWaitMs' "$ROUNDS" \
    && ok "play-rounds.yaml reads nothing between the lobby and round 1's first look for the options (EXP-326)" \
    || ko "play-rounds.yaml reads nothing before round 1's options look" "steps: $steps_before_loop; flow: $flow_timing"
  # The scoreboard closes the three phases after the options showed: after the last look that found none (closesAfter,
  # were the options painted on time), before the options were seen (closesBy, any phase painted up to phaseLagMs
  # late), and opens after opensAfter (the options painted up to optionsLagMs late, EXP-349). The card wait polls until
  # closesBy: with the options seen at the latest one slow read after they showed, that comes before the next round's
  # scoreboard, so a missing card fails on its own round instead of passing on a later one, and it only fails when its
  # looks covered every opening from opensAfter to opensBy (EXP-353). readMs: how long the look that saw them took
  phase_lag="$(flow_ms phaseLagMs)"
  # shellcheck disable=SC2016 # Maestro expressions, not shell ones
  flow_has '- evalScript: ${output.timing.roundMs = output.timing.answeringMs + output.timing.revealMs + output.timing.scoresMs}' \
    && flow_has '- evalScript: "${output.round = { closesAfter: output.options.hiddenFrom && output.options.hiddenFrom + output.timing.roundMs, closesBy: output.options.seenAt + output.timing.roundMs + output.timing.phaseLagMs, readMs: output.options.seenAt - output.options.lookFrom, answering: true, lookFrom: 0, missFrom: 0 }}"' \
    && flow_has '- evalScript: ${output.round.opensBy = output.round.closesBy - output.timing.scoresMs}' \
    && flow_has '- evalScript: ${output.round.coveredTo = output.round.opensAfter = output.round.closesAfter - output.timing.scoresMs - output.timing.optionsLagMs}' \
    && flow_has 'true: ${!output.round.cardWaited && output.round.coveredTo < output.round.opensBy && Date.now() < output.round.closesBy && !(output.round.answeringSeen = false)}' \
    && flow_has 'condition: ${output.round.cardWaited || output.round.coveredTo < output.round.opensBy}' \
    && [ $((answer + reveal + scores + SLOW_STEP_MS + ${phase_lag:-x})) -lt $((answer + reveal + scores + answer + reveal)) ] \
    && ok "the card wait ends when the scoreboard has surely closed, before the next one opens, failing only on its coverage" \
    || ko "closesAfter/closesBy/opensAfter from the options wait, card wait until closesBy, failing on its coverage"
  # EXP-349: the render delays the flow allows cover those maestro-sim.mjs plays (it166's telemetry)
  sim_lags="$(sed -nE 's/^ *const RENDER_LAG_MS = \{ answeringP95: [0-9]+, answering: ([0-9]+), other: ([0-9]+) \};$/\1 \2/p' "$HERE/maestro-sim.mjs")"
  read -r sim_answering_lag sim_other_lag <<<"$sim_lags"
  [ -n "$sim_lags" ] && [ "$(flow_ms optionsLagMs)" -ge "$sim_answering_lag" ] && [ "${phase_lag:-0}" -ge "$sim_other_lag" ] \
    && ok "play-rounds.yaml allows the render delays maestro-sim.mjs plays ($sim_answering_lag ms for the options, $sim_other_lag ms for the rest)" \
    || ko "play-rounds.yaml's render delays cover maestro-sim.mjs's" "sim: ${sim_lags:-none}, flow: $flow_timing"
  # Every scoreboard step starts only before closesAfter, the card wait and the proof look (EXP-350, also a single
  # read) half a read before it and the options check a read before it (EXP-353: one that runs into the next round's
  # options leaves that round no look before them); lab.sh counts the passes of the card wait's guard (lab-play.test.sh
  # keeps them in sync)
  card_guard="true: $(sed -nE "s/^SCOREBOARD_GUARD='(.*)'$/\1/p" "$HERE/../lab.sh")"
  # shellcheck disable=SC2016
  check_guard='true: ${Date.now() < output.round.closesAfter}'
  # shellcheck disable=SC2016
  last_check_guard='true: ${Date.now() + output.round.slowestReadMs < output.round.closesAfter}'
  # shellcheck disable=SC2016
  proof_guard='true: ${!output.round.proofLooked && Date.now() + output.round.readMs / 2 < output.round.closesAfter && Date.now() > output.round.actedAt + output.timing.conditionWaitMs && (output.round.proofLooked = Date.now())}'
  guards="$(awk -v card="$card_guard" -v check="$check_guard" -v last="$last_check_guard" -v proof="$proof_guard" '
    /# ── timed: scores ──/ { on = 1 } /# ── end timed ──/ { on = 0 } { line = $0; sub(/^[ \t]*/, "", line) }
    on && (line == card || line == check || line == last || line == proof) { n++ } END { print n + 0 }' "$ROUNDS")"
  read -r _ _ _ score_steps _ < <(timed_blocks "$ROUNDS" | grep "^BLOCK scores ")
  flow_has "$card_guard" && [ "$guards" = "${score_steps:-x}" ] \
    && ok "each of the $score_steps scoreboard steps starts only before the scoreboard may close" \
    || ko "every scoreboard step guarded by closesAfter" "guards=$guards steps=${score_steps:-}"
fi

# ── hold-used-up.yaml's hold times fit the server's (EXP-176) ──
# Its taps use up the round's holds (MAX_HOLDS_PER_ROUND) and press once more (EXP-361) within the scoreboard's time
# that still lets a hold start (SCORE_DISPLAY_TIME minus HOLD_MIN_REMAINING), and a scoreboard it did not check is
# waited out for the hold budget
HOLD_FLOW="$MAESTRO_DIR/hold-used-up.yaml"
hold_timing="$(sed -nE 's/^- evalScript: "\$\{output\.timing = \{ (.*) \}\}"$/\1/p' "$HOLD_FLOW")"
hold_ms() { tr ',' '\n' <<<"$hold_timing" | sed -nE "s/^ *$1: ([0-9]+) *$/\1/p"; } # KEY -> its value in the flow
hold_min="$(engine_ms HOLD_MIN_REMAINING)" max_holds="$(engine_ms MAX_HOLDS_PER_ROUND)" hold_budget="$(engine_ms HOLD_BUDGET_PER_ROUND)"
hold_taps="$(awk '/^[ \t]*- tapOn:/ { tap = 1; next } tap && /^[ \t]*repeat:/ { print $2; exit } /^[ \t]*- / { tap = 0 }' "$HOLD_FLOW")"
[ -n "$hold_min" ] && [ -n "$max_holds" ] && [ -n "$hold_budget" ] && [ -n "$scores" ] \
  && [ "$(hold_ms scoresMs)" = "$scores" ] && [ "$(hold_ms holdMinMs)" = "$hold_min" ] \
  && [ "$(hold_ms holdBudgetMs)" = "$hold_budget" ] && [ "$hold_taps" = "$((max_holds + 1))" ] \
  && ok "hold-used-up.yaml taps $hold_taps times and copies GameEngine.ts's hold times ($scores/$hold_min/$hold_budget ms)" \
  || ko "hold-used-up.yaml's hold times match GameEngine.ts" \
    "engine: scores=$scores min=$hold_min holds=$max_holds budget=$hold_budget; flow: taps=$hold_taps $hold_timing"
[ "$(blocks_of hold-used-up.yaml scores)" = 1 ] \
  && ok "hold-used-up.yaml budgets its steps on the device's scoreboard" || ko "hold-used-up.yaml has a scores block"
# EXP-354: hold-closed greys the button out by itself from the 1.5 s mark, so the presses reach the server and the
# "no holds left" look ends before it could (closingFrom: hiddenFrom less the phone's paint delay of the scoreboard,
# EXP-361, the same phaseLagMs as play-rounds.yaml's, plus the hold window): the look proves the holds only by a read
# that ended before it (one that ends after it could see the screen after hold-closed), and nothing is bound to the
# scoreboard's close any more. maestro-sim.mjs plays the flow against those bounds (scenario `hold`, below; it also
# checks that the flow without phaseLagMs in closingFrom would pass on a broken app)
# shellcheck disable=SC2016
# The same bound in hold-closed.yaml (EXP-391, below)
hold_closing_from='${output.round.closingFrom = output.look.hiddenFrom - output.timing.phaseLagMs + output.timing.scoresMs - output.timing.holdMinMs}'
used_up_bounded() { # FLOW -> whether its used-up check proves the holds only before closingFrom
  # shellcheck disable=SC2016
  grep -qF "evalScript: $hold_closing_from" "$1" \
    && grep -qF '!output.round.usedUpLooked && output.round.tappedBy + output.timing.tapLatencyMs < output.round.closingFrom' "$1" \
    && grep -qF 'assertTrue: ${(output.round.usedUp = output.round.greySeenAt > 0 && output.round.greySeenAt < output.round.closingFrom), true}' "$1" \
    && grep -qF 'assertTrue: ${output.round.greySeenAt = Date.now()}' "$1" \
    && ! grep -q 'closesAfter' "$1"
}
[ "$(hold_ms phaseLagMs)" = "${phase_lag:-x}" ] && used_up_bounded "$HOLD_FLOW" \
  && ok "hold-used-up.yaml proves the used up holds only with reads that end before hold-closed could grey the button out" \
  || ko "hold-used-up.yaml's check bound by closingFrom (hiddenFrom - phase lag + scores - hold min)" \
    "phaseLagMs: hold-used-up $(hold_ms phaseLagMs), play-rounds ${phase_lag:-none}"
# The bound before EXP-361: a greyed out button seen at any time of the look counted
# shellcheck disable=SC2016
sed 's/output.round.greySeenAt < output.round.closingFrom/true/' \
  "$HOLD_FLOW" >"$TMP/hold-used-up-late-read.yaml"
! used_up_bounded "$TMP/hold-used-up-late-read.yaml" \
  && ok "checker rejects a used-up look whose read may end after closingFrom" \
  || ko "checker rejects the unbounded used-up look"

# ── hold-closed.yaml's times fit the server's (EXP-354) ──
# Without tapping: the button is enabled while the hold window is surely open (until hiddenFrom + SCORE_DISPLAY_TIME -
# HOLD_MIN_REMAINING), then greyed out before the scoreboard is surely over (seenAt + SCORE_DISPLAY_TIME)
CLOSED_FLOW="$MAESTRO_DIR/hold-closed.yaml"
closed_timing="$(sed -nE 's/^- evalScript: "\$\{output\.timing = \{ (.*) \}\}"$/\1/p' "$CLOSED_FLOW")"
closed_ms() { tr ',' '\n' <<<"$closed_timing" | sed -nE "s/^ *$1: ([0-9]+) *$/\1/p"; } # KEY -> its value in the flow
[ -n "$hold_min" ] && [ -n "$scores" ] && [ "$(closed_ms scoresMs)" = "$scores" ] && [ "$(closed_ms holdMinMs)" = "$hold_min" ] \
  && ok "hold-closed.yaml copies GameEngine.ts's scoreboard and hold window times ($scores/$hold_min ms)" \
  || ko "hold-closed.yaml's times match GameEngine.ts" "engine: scores=$scores min=$hold_min; flow: $closed_timing"
# EXP-391: the same closingFrom as hold-used-up.yaml's, less the phone's paint delay of the scoreboard
closed_bounded() { # FLOW -> whether it waits for the enabled button only while the window is surely open, then until closesBy
  # shellcheck disable=SC2016
  grep -qF "evalScript: $hold_closing_from" "$1" \
    && grep -qF 'evalScript: ${output.round.closesBy = output.look.seenAt + output.timing.scoresMs}' "$1" \
    && grep -qF 'true: ${output.round.known && Date.now() + output.round.readMs < output.round.closingFrom}' "$1" \
    && grep -qF 'timeout: ${output.round.closingFrom - Date.now()}' "$1" \
    && grep -qF 'timeout: ${output.round.closesBy - Date.now()}' "$1"
}
[ "$(closed_ms phaseLagMs)" = "${phase_lag:-x}" ] && closed_bounded "$CLOSED_FLOW" \
  && ok "hold-closed.yaml waits for the enabled button until closingFrom (less a late painted scoreboard) and the greyed out one until closesBy" \
  || ko "hold-closed.yaml's waits bound by closingFrom / closesBy" \
    "phaseLagMs: hold-closed $(closed_ms phaseLagMs), play-rounds ${phase_lag:-none}"
# The bound before EXP-391: the scoreboard taken as painted on time
# shellcheck disable=SC2016
sed 's/output.look.hiddenFrom - output.timing.phaseLagMs + /output.look.hiddenFrom + /' "$CLOSED_FLOW" >"$TMP/hold-closed-on-time.yaml"
! closed_bounded "$TMP/hold-closed-on-time.yaml" \
  && ok "checker rejects a closingFrom that takes the scoreboard as painted on time" \
  || ko "checker rejects the closingFrom without phaseLagMs"
[ "$(blocks_of hold-closed.yaml scores)" = 1 ] && ! grep -qE '^[[:space:]]*- (tapOn|longPressOn|swipe):' "$CLOSED_FLOW" \
  && ok "hold-closed.yaml budgets its steps on the device's scoreboard and taps nothing" \
  || ko "hold-closed.yaml has a scores block and no taps"

# ── The kick after the game comes when the flows expect it (EXP-346) ──
# The host bot removes the device D s after game over (--kick-after-game D, as each flow documents its run). By then the
# device must be done with play-rounds.yaml, at its slowest: the round loop's closing pass (the game over can come just
# after its look for the options: then its optional tap on an option that is gone, the round screenshot and the
# game-over look that ends the loop), then every step after the loop as a slow read on top of its full timeout. A kick
# inside them sends it home mid-flow. Each flow then waits for the kick at least D s from after game over: on the final
# ranking for the notice (kicked-after-game.yaml), or with the app closed so that it misses the kick
# (kicked-while-offline.yaml).
# An optional step whose element is not there: Maestro looks for it this long before going on
OPTIONAL_MISS_MS=7000
# The closing pass after the game over: the optional tap's miss and three slow reads (options look, screenshot, game-over look)
CLOSING_PASS_MS=$((OPTIONAL_MISS_MS + 3 * SLOW_STEP_MS))
# rounds_tail FLOW -> "<timeouts ms> <steps>" of the steps after the flow's last top-level repeat (nested ones too): their
# timeouts summed, and how many touch the device (all but evalScript / assertTrue)
rounds_tail() {
  awk '/^- repeat:/ { loop = 1; after = 0; sum = 0; steps = 0; next } loop && /^- / { loop = 0; after = 1 }
    after && /^[ \t]*- [A-Za-z]+/ && !/^[ \t]*- (evalScript|assertTrue)(:|$)/ { steps++ }
    after && /^[ \t]+timeout: [0-9]+/ { sum += $2 } END { print sum + 0, steps + 0 }' "$1"
}
# step_timeout FLOW LABEL -> the timeout (ms) of the top-level step labelled LABEL, empty if there is none
step_timeout() {
  awk -v label="label: \"$2\"" '
    /^- / && hit && !done { print t; done = 1 } /^- / { t = ""; hit = 0 }
    /^[ \t]+timeout: [0-9]+/ { t = $2 }
    { line = $0; sub(/^[ \t]+/, "", line) } line == label { hit = 1 }
    END { if (hit && !done) print t }' "$1"
}
printf -- '- repeat:\n    commands:\n      - extendedWaitUntil:\n          timeout: 1000\n- extendedWaitUntil:\n    timeout: 5000\n- assertTrue: ${true}\n- runFlow:\n    commands:\n      - extendedWaitUntil:\n          timeout: 7000\n          label: "x"\n      - evalScript: ${1}\n- tapOn: "a"\n' >"$TMP/tail.yaml"
[ "$(rounds_tail "$TMP/tail.yaml")" = "12000 4" ] && [ "$(step_timeout "$TMP/tail.yaml" x)" = 7000 ] && [ -z "$(step_timeout "$TMP/tail.yaml" y)" ] \
  && ok "checker sums the waits and counts the device steps after the round loop, and reads a labelled step's timeout" \
  || ko "checker reads the tail and labelled waits" "tail=$(rounds_tail "$TMP/tail.yaml") x=$(step_timeout "$TMP/tail.yaml" x)"
read -r tail_timeouts tail_steps < <(rounds_tail "$ROUNDS")
rounds_tail=$((CLOSING_PASS_MS + tail_timeouts + tail_steps * SLOW_STEP_MS))
kick_wait_label() { case $1 in
  kicked-after-game.yaml) echo "The host's kick after the game reaches the final ranking";;
  kicked-while-offline.yaml) echo "The app stays closed until the host's kick after the game";; esac; }
for flow in kicked-after-game.yaml kicked-while-offline.yaml; do
  kick_s="$(grep -oE -- '--kick-after-game [0-9]+' "$MAESTRO_DIR/$flow" | head -1 | grep -oE '[0-9]+$')"
  wait_ms="$(step_timeout "$MAESTRO_DIR/$flow" "$(kick_wait_label "$flow")")"
  grep -q -- "^- runFlow: play-rounds.yaml$" "$MAESTRO_DIR/$flow" && [ -n "$kick_s" ] && [ "$tail_steps" -gt 0 ] \
    && [ $((kick_s * 1000)) -ge "$rounds_tail" ] \
    && ok "$flow: the kick (${kick_s} s after game over) comes after play-rounds.yaml is done ($rounds_tail ms: closing pass $CLOSING_PASS_MS + waits $tail_timeouts + $tail_steps slow reads)" \
    || ko "$flow: the kick comes after play-rounds.yaml is done" "kick=${kick_s:-none} s, play-rounds after game over=$rounds_tail ms"
  [ -n "$wait_ms" ] && [ -n "$kick_s" ] && [ "$wait_ms" -ge $((kick_s * 1000)) ] \
    && ok "$flow: waits $wait_ms ms for the kick ${kick_s} s after game over" \
    || ko "$flow: waits for the kick after game over" "wait=${wait_ms:-none} ms, kick=${kick_s:-none} s"
done

# ── play-rounds.yaml on a fake game with slow screen reads (EXP-312, EXP-322, EXP-326, EXP-349, EXP-353, EXP-355) ──
# With reads that see the screen as they start, as they end and anywhere along them (those also with it166's render
# delays): every guess lands while answering (round 1's too, also when the lobby wait ends after its options showed;
# a few lost when the options are painted late), no scoreboard check passes after its scoreboard closed (reads seen as
# they start), slower phones (fixed and seeded random reads) lose few guesses and never fail by mistake, bot holds (up
# to three a round) included; a missing card, the device's own name on it or a round photo that never loads still
# fail, the wrong scoreboards on most rounds of fast phones and on nearly every game when on every round
# (maestro-sim.mjs: Maestro 2.11 semantics, phase lengths and hold rules from GameEngine.ts; SIM_SEE_SEED draws other
# read points)
if out="$(node "$HERE/maestro-sim.mjs" rounds "$ROUNDS" "$CLIENT_APP" 2>&1)"; then
  while IFS=$'\t' read -r name verdict detail; do
    [ "$verdict" = ok ] && ok "play-rounds.yaml: $name" || ko "play-rounds.yaml: $name" "$detail"
  done <<<"$out"
else
  ko "play-rounds.yaml: the simulator runs the flow" "$(tr '\n' ' ' <<<"$out")"
fi

# ── hold-used-up.yaml on a fake game of its own (EXP-361) ──
# With reads of 0.3 to 4 s seen anywhere along them and its scoreboard's events painted late: it never passes on an app
# whose button greys out only at hold-closed or whose 4th press holds, every pass on the correct app is proven, and it
# fails there only for want of an own scoreboard reached in time; each line states the pass rate
if out="$(node "$HERE/maestro-sim.mjs" hold "$HOLD_FLOW" "$CLIENT_APP" 2>&1)"; then
  while IFS=$'\t' read -r name verdict detail; do
    [ "$verdict" = ok ] && ok "hold-used-up.yaml: $name" || ko "hold-used-up.yaml: $name" "$detail"
  done <<<"$out"
else
  ko "hold-used-up.yaml: the simulator runs the flow" "$(tr '\n' ' ' <<<"$out")"
fi

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
