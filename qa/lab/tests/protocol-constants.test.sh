#!/usr/bin/env bash
# Protocol constants the app copies from the server (EXP-217): each copy has the server's value, and each limit of the
# app's own never lets through what the server refuses (a longer name, a faster chat message). The bots' copies are
# checked by bots-cli.test.sh. Static: reads the sources, no devices, servers or network.
# Run: qa/lab/tests/protocol-constants.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SRC="${SERVER_SRC:-$HERE/../../../Server}"
CLIENT_SRC="${CLIENT_SRC:-$HERE/../../../Client}"
LIMITS="app/utils/protocolLimits.ts"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# initializer FILE NAME -> the text between `const NAME = ` (or `const NAME: Type = `) and `;` (one-line declarations),
# digit separators removed
initializer() { sed -n "s/^\(export \)\{0,1\}const $2\(: [^=]*\)\{0,1\} = \([^;]*\);.*/\3/p" "$1" 2>/dev/null | tr -d _; }

mirrors() { # client file, client const, server file, server const: same initializer on both sides
  local ours theirs
  ours="$(initializer "$CLIENT_SRC/$1" "$2")"; theirs="$(initializer "$SERVER_SRC/$3" "$4")"
  [[ -n "$theirs" && "$ours" == "$theirs" ]] && ok "$2 matches the server's $4" || ko "$2 matches the server's $4" "app=[$ours] server=[$theirs]"
}

# within LABEL APP_VALUE OP SERVER_VALUE: the app's own limit stays on the server's side of it (OP: -le, -ge or -eq)
within() {
  [[ "$2" =~ ^[0-9]+$ && "$4" =~ ^[0-9]+$ ]] && [ "$2" "$3" "$4" ] && ok "$1" || ko "$1" "app=[$2] server=[$4]"
}

# ── Copies of the server's values ──
mirrors "$LIMITS" ROUND_OPTIONS managers/RoomManager.ts ROUND_OPTIONS
mirrors "$LIMITS" MAX_CHAT_LENGTH routes/socketRoutes.ts MAX_CHAT_LENGTH
mirrors app/utils/roomCode.ts ROOM_CODE_ALPHABET managers/roomCode.ts ROOM_CODE_ALPHABET
mirrors app/utils/roomCode.ts ROOM_CODE_LENGTH managers/roomCode.ts ROOM_CODE_LENGTH

# Emoji reactions: the picker's emojis plus the screenshot one are exactly what the server relays (ALLOWED_EMOJIS)
quoted() { grep -o '"[^"]*"' | LC_ALL=C sort | tr '\n' ' '; }
app_emojis="$( { initializer "$CLIENT_SRC/app/utils/reactions.ts" REACTION_EMOJIS; initializer "$CLIENT_SRC/app/utils/reactions.ts" SCREENSHOT_EMOJI; } | quoted)"
server_emojis="$(initializer "$SERVER_SRC/managers/socketGuards.ts" ALLOWED_EMOJIS | quoted)"
[[ -n "$server_emojis" && "$app_emojis" == "$server_emojis" ]] && ok "REACTION_EMOJIS + SCREENSHOT_EMOJI match the server's ALLOWED_EMOJIS" \
  || ko "REACTION_EMOJIS + SCREENSHOT_EMOJI match the server's ALLOWED_EMOJIS" "app=[$app_emojis] server=[$server_emojis]"

# ── The app's own limits, inside the server's ──
# The name input takes exactly the names the server accepts: no name the server refuses, none it accepts cut (DEC-043)
within "MAX_USERNAME_INPUT_LENGTH equals the server's MAX_USERNAME_LENGTH" \
  "$(initializer "$CLIENT_SRC/$LIMITS" MAX_USERNAME_INPUT_LENGTH)" -eq "$(initializer "$SERVER_SRC/managers/playerName.ts" MAX_USERNAME_LENGTH)"
chat_limit="$(initializer "$SERVER_SRC/managers/socketGuards.ts" CHAT_MESSAGE_LIMIT)"   # { max: N, windowMs: W } as const
chat_max="$(sed -n 's/.*max: *\([0-9]*\).*/\1/p' <<<"$chat_limit")"
chat_window="$(sed -n 's/.*windowMs: *\([0-9]*\).*/\1/p' <<<"$chat_limit")"
[ "$chat_max" = 1 ] && ok "CHAT_MESSAGE_LIMIT allows one message per window" || ko "CHAT_MESSAGE_LIMIT allows one message per window" "[$chat_limit]"
within "CHAT_COOLDOWN_MS is at least the server's CHAT_MESSAGE_LIMIT window" \
  "$(initializer "$CLIENT_SRC/$LIMITS" CHAT_COOLDOWN_MS)" -ge "$chat_window"

# ── The app uses the named limits, not literals ──
grep -q 'maxLength={MAX_USERNAME_INPUT_LENGTH}' "$CLIENT_SRC/app/index.tsx" && ok "home name input uses MAX_USERNAME_INPUT_LENGTH" || ko "home name input uses MAX_USERNAME_INPUT_LENGTH"
grep -q 'maxLength={MAX_CHAT_LENGTH}' "$CLIENT_SRC/app/screens/WaitingRoom.tsx" && ok "lobby chat input uses MAX_CHAT_LENGTH" || ko "lobby chat input uses MAX_CHAT_LENGTH"
grep -q 'ROUND_OPTIONS.map(' "$CLIENT_SRC/app/screens/WaitingRoom.tsx" && ok "lobby rounds picker uses ROUND_OPTIONS" || ko "lobby rounds picker uses ROUND_OPTIONS"
grep -q '>= CHAT_COOLDOWN_MS' "$CLIENT_SRC/app/screens/WaitingRoom.tsx" && ok "lobby chat cooldown uses CHAT_COOLDOWN_MS" || ko "lobby chat cooldown uses CHAT_COOLDOWN_MS"

echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
