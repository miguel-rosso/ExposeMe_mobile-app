#!/usr/bin/env bash
# EXP-290: the round flow checks, while the scoreboard is up, that the card never shows the phone's own name (so on
# the owner's phone it takes its "It was your photo!" branch), and quit-after-game-over.yaml checks that a bot gone at
# game over haunts neither the lobby nor the next game on the device. Static: no devices, servers or network
# (`maestro check-syntax` runs only if Maestro is installed).
# Run: qa/lab/tests/maestro-owner-card.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="${MAESTRO_DIR:-$HERE/../../maestro}"
I18N="$HERE/../../../Client/app/i18n"
TEST_IDS="$HERE/../../../Client/app/utils/testIds.ts"
BOTS="$HERE/../bots.mjs"
ROUNDS="$MAESTRO_DIR/play-rounds.yaml"
GHOST_FLOW="$MAESTRO_DIR/quit-after-game-over.yaml"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# ── Helpers ──
# own_name_check FLOW -> the text filter of the card name that must not be visible inside the timed scores block
own_name_check() {
  awk '
    /^[ \t]*# ── timed: scores ──/ { in_scores = 1; next }
    /^[ \t]*# ── end timed ──/ { in_scores = 0 }
    !in_scores { next }
    /^[ \t]*notVisible:/ { in_not = 1; next }
    in_not && /^[ \t]*id: "score-answer-name"$/ { card = NR; next }
    card && NR == card + 1 && /^[ \t]*text:/ { v = $0; sub(/^[ \t]*text:[ \t]*"/, "", v); sub(/"[ \t]*$/, "", v); print v; exit }
    /^[ \t]*- / { in_not = 0; card = 0 }
  ' "$1"
}
# i18n_string LOCALE KEY -> the app string (Client/app/i18n/<locale>.ts, `key: "value",`)
i18n_string() { sed -nE "s/^[ \t]*$2: \"(.*)\",?$/\1/p" "$I18N/$1.ts"; }
# maestro_matches REGEX TEXT -> exit 0 if Maestro's text filter matches TEXT: Kotlin Regex.matches (the whole text)
# with IGNORE_CASE and DOT_MATCHES_ALL (the texts here have no line breaks, so MULTILINE changes nothing)
maestro_matches() {
  node -e 'process.exit(new RegExp(`^(?:${process.argv[1]})$`, "is").test(process.argv[2]) ? 0 : 1)' "$1" "$2"
}
# line_of FLOW PATTERN [AFTER] -> first line number after line AFTER (default 0) matching PATTERN (empty if none)
line_of() { awk -v re="$2" -v after="${3:-0}" 'NR > after && $0 ~ re { print NR; exit }' "$1"; }

# ── play-rounds.yaml: the card never shows the phone's own name; on the owner's phone it says "It was your photo!" ──
filter="$(own_name_check "$ROUNDS")"
[ "$filter" = '${USERNAME}' ] && ok "play-rounds.yaml checks the card for the device's own name in its scores block" \
  || ko "play-rounds.yaml checks the card for the device's own name in its scores block" "${filter:-none}"
# What the card shows on the device ios-a (USERNAME): Maestro substitutes the name into the filter
device=ios-a
check="${filter//'${USERNAME}'/$device}"
maestro_matches "$check" "$device" && ok "the owner's card showing its own name ($device) fails the check" \
  || ko "the owner's card showing its own name ($device) fails the check" "$check"
for locale in en es; do
  phrase="$(i18n_string "$locale" itWasYourPhoto)"
  if [ -z "$phrase" ]; then ko "$locale itWasYourPhoto read from the i18n file"; continue; fi
  ! maestro_matches "$check" "$phrase" \
    && ok "$locale owner's card ('$phrase') passes the check" || ko "$locale owner's card ('$phrase') passes the check" "$check"
done
# Another player's round: their name passes, also names that only contain or extend the device's
for text in android-b bot1 ios-a2 xios-a ""; do
  ! maestro_matches "$check" "$text" && ok "a card showing '$text' passes the check" || ko "a card showing '$text' passes the check" "$check"
done

# ── quit-after-game-over.yaml: the bot that quits at game over haunts nothing on the device ──
# bots.mjs: the quitter is the last bot (QUITTER = N_BOTS - 1, named bot<i + 1>), bot3 with the flow's --bots 3
ghost=bot3
grep -q 'const QUITTER = N_BOTS - 1;' "$BOTS" && grep -q 'bot${i + 1}`' "$BOTS" \
  && ok "bots.mjs: the quitter is the last bot" || ko "bots.mjs: the quitter is the last bot"
grep -q -- '--flow quit-after-game-over --bots 3 ' "$GHOST_FLOW" && grep -q -- '--bot-args "--quit-after-game-over"' "$GHOST_FLOW" \
  && ok "quit-after-game-over.yaml documents its run with 3 bots" || ko "quit-after-game-over.yaml documents its run with 3 bots"
# Every selector it uses for the ghost is a testID the app renders (Client/app/utils/testIds.ts)
for prefix in player-option score-rank final-rank lobby-player-offline; do
  grep -q "\`$prefix-\${username}\`" "$TEST_IDS" && ok "testIds.ts has $prefix-<username>" || ko "testIds.ts has $prefix-<username>"
done
# Each "not there" check comes after a check that the same screen is up with a live player, so it can't pass
# vacuously on another screen: options, a scoreboard, the final ranking of the next game
check_after() { # LABEL, line of the live check, line of the ghost check
  [ -n "$2" ] && [ -n "$3" ] && [ "$2" -lt "$3" ] && ok "$1" || ko "$1" "live=${2:-none} ghost=${3:-none}"
}
ghost_check() { # testID -> line of its assertNotVisible
  awk -v id="$1" '/assertNotVisible:/ { n = NR } n && NR == n + 1 && index($0, "id: \"" id "\"") { print NR - 1; exit }' "$GHOST_FLOW"
}
next_game="$(line_of "$GHOST_FLOW" 'id: "lobby-player-offline-bot3')"
next_options="$(line_of "$GHOST_FLOW" 'id: "player-option-bot1"' "$next_game")"
check_after "ghost dimmed in the lobby before the next game's checks" "$next_game" "$next_options"
check_after "next game's options without $ghost" "$next_options" "$(ghost_check "player-option-$ghost")"
check_after "next game's scoreboard without $ghost" "$(line_of "$GHOST_FLOW" 'id: "score-round-title"' "$next_game")" "$(ghost_check "score-rank-$ghost")"
check_after "next game's final ranking without $ghost" "$(line_of "$GHOST_FLOW" 'id: "final-rank-bot1"' "$next_game")" "$(ghost_check "final-rank-$ghost")"
# The next game is played with the round flow (with its owner-card check). The first one runs its round loop inline:
# play-rounds.yaml's final winner/ranking waits race the bots' next game on a slow phone, so play again is retried.
[ "$(grep -c '^- runFlow: play-rounds.yaml$' "$GHOST_FLOW")" = 1 ] && [ "$(line_of "$GHOST_FLOW" '^- runFlow: play-rounds.yaml$')" -gt "$next_game" ] \
  && ok "only the next game runs play-rounds.yaml" || ko "only the next game runs play-rounds.yaml"
retry="$(awk '/^- repeat:/ { r = NR } r && /id: "play-again-button"/ { print r; exit }' "$GHOST_FLOW")"
check_after "play again retried in a loop before the next game's checks" "$retry" "$next_game"
grep -A3 'id: "play-again-button"' "$GHOST_FLOW" | grep -q 'optional: true' && grep -A3 'id: "winner-continue"' "$GHOST_FLOW" | grep -q 'optional: true' \
  && ok "the play-again taps are optional (the next game can take the device in first)" \
  || ko "the play-again taps are optional (the next game can take the device in first)"

# ── Maestro parses both flows ──
if command -v maestro >/dev/null 2>&1; then
  for flow in "$ROUNDS" "$GHOST_FLOW"; do
    out="$(maestro check-syntax "$flow" 2>&1)" && ok "maestro check-syntax $(basename "$flow")" \
      || ko "maestro check-syntax $(basename "$flow")" "$out"
  done
else
  echo "skip - maestro not installed: check-syntax not run"
fi

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
