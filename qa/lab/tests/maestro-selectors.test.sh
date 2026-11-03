#!/usr/bin/env bash
# The boot flows find the app by testID, never by its translated text (EXP-048): open-app.yaml and its
# dev-client-boot.yaml subflow may only use text for the Expo dev-client UI and system alerts, or to check the
# language of an element already matched by id. A text selector that matches any app string (Client/src/i18n) breaks
# in other languages and can hit the app instead of the dev menu. hold-used-up.yaml and hold-closed.yaml filter the
# hold button by its noHoldsLeft text: in both languages, as the app has it (EXP-176, EXP-354). The kick flows read the
# host's removal notice, a system alert, by its text: message, title and button as the app has them in both languages
# (EXP-346). Static: no devices, servers or network.
# Run: qa/lab/tests/maestro-selectors.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="${MAESTRO_DIR:-$HERE/../../maestro}"
CLIENT_APP="$HERE/../../../Client/src"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

BOOT_FLOWS="open-app.yaml dev-client-boot.yaml"
BOOT="$MAESTRO_DIR/dev-client-boot.yaml"

# ── Checker ──
# text_selectors FLOW -> "<line>\t<pattern>" for each text selector that is not paired with an id in the same selector
text_selectors() {
  awk '
    function unquote(v) { sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2); return v }
    /^[ \t]*(#|$)/ { next }
    {
      line = $0; sub(/^[ \t]*- /, "", line); sub(/^[ \t]+/, "", line)
      indent = match($0, /[^ \t-]/) - 1
      while (depth > 0 && stack_indent[depth] >= indent) depth--
      parent = depth > 0 ? stack_line[depth] : 0
      depth++; stack_indent[depth] = indent; stack_line[depth] = NR
    }
    line ~ /^id:/ { has_id[parent] = 1 }
    line ~ /^text:/ { v = line; sub(/^text:/, "", v); keyed[NR] = unquote(v); keyed_parent[NR] = parent }
    line ~ /^(tapOn|assertVisible|assertNotVisible|visible|notVisible|from|scrollUntilVisible):[ \t]*[^ \t{#]/ {
      v = line; sub(/^[A-Za-z]+:/, "", v); print NR "\t" unquote(v)
    }
    END { for (n in keyed) if (!has_id[keyed_parent[n]]) print n "\t" keyed[n] }
  ' "$1" | sort -n
}

# i18n_js APP JS [ARGS...] -> runs JS (node) with `en` and `es`, the objects APP/i18n/{en,es}.ts export, and `args`
i18n_js() {
  local app=$1 js=$2; shift 2
  node -e '
    const fs = require("fs");
    const load = (f) => new Function(fs.readFileSync(f, "utf8").replace(/^export default/m, "return").replace(/\}\s*as const;\s*$/, "}"))();
    const [en, es] = process.argv.slice(1, 3).map(load);
    const args = process.argv.slice(3);
  '"$js" "$app/i18n/en.ts" "$app/i18n/es.ts" "$@"
}

# app_strings OUT APP -> every en/es string of the app, NUL-separated
app_strings() {
  i18n_js "$2" 'process.stdout.write([en, es].flatMap(Object.values).filter((v) => typeof v === "string").join("\0"));' >"$1"
}

# i18n_value KEY -> "<en>|<es>" of that key of the app
i18n_value() { i18n_js "$CLIENT_APP" 'process.stdout.write(`${en[args[0]]}|${es[args[0]]}`);' "$1"; }

# app_text_hits SELECTORS STRINGS -> "<line>\t<pattern>\t<app string>" for each selector that matches an app string
# (Maestro matches the whole text, case-insensitively with . matching line breaks, also with line breaks read as spaces)
app_text_hits() {
  perl -e '
    my ($selectors, $strings) = @ARGV;
    open my $fh, "<", $strings or die; local $/; my @app = split /\0/, <$fh>; close $fh;
    open $fh, "<", $selectors or die; $/ = "\n";
    while (<$fh>) {
      chomp; my ($line, $pattern) = split /\t/, $_, 2;
      my $re = eval { qr/\A(?:$pattern)\z/ism } or next;
      for my $s (@app) { (my $flat = $s) =~ s/\n/ /g; if ($s =~ $re || $flat =~ $re) { $s =~ s/\n/\\n/g; print "$line\t$pattern\t$s\n"; last } }
    }
  ' "$1" "$2"
}

# unknown_ids FLOW -> each alternative of an `id:` selector that matches no testID in Client/src/utils/testIds.ts:
# neither one of its strings nor an id of one of its helpers (`(username: string) => \`winner-name-${username}\``).
# A helper's id is its prefix followed by a flow variable (${USERNAME}), .* / .+, or a value of the helper's
# parameter: a name (letters, digits, "_": no "-", so a misspelt longer prefix like lobby-player-offlne-bot1 is not
# read as lobby-player-'s name) for a string, digits or \d+ for a number. Nor may it be the start of a longer
# prefix's rest (lobby-player-offline is not lobby-player-'s player "offline").
unknown_ids() {
  grep -oE '^[[:space:]]*id: "[^"]*"' "$1" | sed -E 's/.*id: "(.*)"/\1/' | tr '|' '\n' | sort -u >"$TMP/ids"
  grep -oE '"[a-z0-9-]+"' "$2/utils/testIds.ts" | tr -d '"' >"$TMP/known-ids"
  # "<prefix> <parameter type>" of each helper
  grep -oE ': (string|number)\) => `[a-z0-9-]+\$\{' "$2/utils/testIds.ts" \
    | sed -E 's/^: (string|number)\) => `(.*)\$\{$/\2 \1/' >"$TMP/known-helpers"
  perl -e '
    open my $fh, "<", $ARGV[1] or die; chomp(my @known = <$fh>); close $fh;
    open $fh, "<", $ARGV[2] or die; my @helpers = map { chomp; [split / /] } <$fh>; close $fh;
    my %value = (string => qr/\A[A-Za-z0-9_]+\z/, number => qr/\A(?:[0-9]+|\\d\+)\z/);
    my $any = qr/\A(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\.\*|\.\+)\z/;
    sub helper_id {
      my ($id) = @_;
      for my $h (@helpers) {
        my ($prefix, $type) = @$h;
        next unless index($id, $prefix) == 0;
        my $rest = substr($id, length $prefix);
        next if grep { my $p = $_->[0]; length($p) > length($prefix) && index($p, $prefix) == 0
          && index(substr($p, length $prefix), $rest) == 0 } @helpers;
        return 1 if $rest =~ $any || $rest =~ $value{$type};
      }
      return 0;
    }
    open $fh, "<", $ARGV[0] or die;
    while (my $id = <$fh>) {
      chomp $id;
      next if helper_id($id);
      my $re = eval { qr/\A(?:$id)\z/ism };
      print "$id\n" unless $re && grep { $_ =~ $re } @known;
    }
  ' "$TMP/ids" "$TMP/known-ids" "$TMP/known-helpers"
}
# Flows besides the boot ones whose ids are all checked against testIds.ts (EXP-176, EXP-348, EXP-346, EXP-354, EXP-339,
# EXP-390, EXP-424, EXP-425, EXP-422)
ID_CHECKED_FLOWS="tie-game.yaml hold-used-up.yaml hold-closed.yaml kicked-after-game.yaml kicked-while-offline.yaml kicked-mid-game.yaml join-room.yaml search-room.yaml kicked-notice.yaml device-host-start.yaml device-host-kick-mid-game.yaml unknown-link.yaml unknown-link-home.yaml server-unreachable.yaml lobby-chat-mask.yaml mute-player.yaml"
# Flows that read the host's removal notice, a system alert matched by its text (EXP-139, EXP-346, EXP-425)
KICK_NOTICE_FLOWS="kicked-notice.yaml kicked-after-game.yaml kicked-while-offline.yaml kicked-mid-game.yaml"

# matches_i18n PATTERN KEY -> whether the Maestro text PATTERN matches the app's KEY string in both en and es (whole
# text, case-insensitively, like Maestro)
matches_i18n() {
  i18n_js "$CLIENT_APP" '
    const re = new RegExp(`^(?:${args[0]})$`, "is");
    process.exit([en, es].every((lang) => typeof lang[args[1]] === "string" && re.test(lang[args[1]])) ? 0 : 1);
  ' "$1" "$2"
}

# ── The checker catches app text (fixture flow) ──
mkdir -p "$TMP/app/i18n" "$TMP/app/utils"
printf 'export default {\n  joinGame: "Join Game",\n  title: "YOUR GALLERY\\nIS THE GAME",\n  continue_: '\''Continue'\'',\n} as const;\n' >"$TMP/app/i18n/en.ts"
printf 'export default {\n  joinGame: "Unirse a Partida",\n} as const;\n' >"$TMP/app/i18n/es.ts"
printf 'export const TEST_IDS = {\n  joinGameButton: "join-game-button",\n  initialTitle: "initial-title",\n} as const;\n' >"$TMP/app/utils/testIds.ts"
cat >"$TMP/flow.yaml" <<'EOF'
- extendedWaitUntil:
    visible: "This is the developer menu.*|Join Game"
    timeout: 1000
- runFlow:
    when:
      visible:
        id: "initial-title"
        text: "(?s)YOUR GALLERY.*"
    commands:
      - tapOn:
          text: "Unirse a Partida"
      - tapOn: "Continue"
      - tapOn: "Development servers"
      # tapOn: "Join Game"
- assertVisible:
    id: "join-game-button|initial-screen"
- tapOn: YOUR GALLERY IS THE GAME
- tapOn: "join game"
EOF
app_strings "$TMP/strings" "$TMP/app"
text_selectors "$TMP/flow.yaml" >"$TMP/selectors"
app_text_hits "$TMP/selectors" "$TMP/strings" >"$TMP/hits"
for hit in "2	This is the developer menu.*|Join Game	Join Game" "11	Unirse a Partida	Unirse a Partida" \
  "12	Continue	Continue" "17	YOUR GALLERY IS THE GAME	YOUR GALLERY\\nIS THE GAME" "18	join game	Join Game"; do
  grep -qxF "$hit" "$TMP/hits" && ok "checker flags: ${hit//	/ -> }" || ko "checker flags: ${hit//	/ -> }" "$(cat "$TMP/hits")"
done
[ "$(wc -l <"$TMP/hits" | tr -d ' ')" = 5 ] \
  && ok "checker skips id+text, dev-client text and comments" || ko "checker reports only app text" "$(cat "$TMP/hits")"
[ "$(unknown_ids "$TMP/flow.yaml" "$TMP/app")" = initial-screen ] \
  && ok "checker flags an id missing from testIds.ts" || ko "checker flags unknown ids" "$(unknown_ids "$TMP/flow.yaml" "$TMP/app")"
# Per-player / per-item ids come from the helpers: a value of the helper's parameter, a flow variable or a pattern
# after its prefix; a misspelt prefix, an empty or wrong-typed value, or a cut longer prefix is flagged
cat >>"$TMP/app/utils/testIds.ts" <<'EOF'
export const winnerNameId = (username: string) => `winner-name-${username}`;
export const lobbyPlayerId = (username: string) => `lobby-player-${username}`;
export const lobbyPlayerOfflineId = (username: string) => `lobby-player-offline-${username}`;
export const roundsOptionId = (rounds: number) => `rounds-option-${rounds}`;
EOF
good_ids='winner-name-bot1|winner-name-${USERNAME}|winner-name-.*|lobby-player-bot1|lobby-player-${USERNAME}|lobby-player-offline-${USERNAME}|lobby-player-offline-.*|rounds-option-10|rounds-option-\d+|rounds-option-${ROUNDS}|rounds-option-.*'
bad_ids='winner-name-|winner-nmae-bot1|lobby-player-offlne-${USERNAME}|lobby-player-offlne-bot1|lobby-player-offline|lobby-player-offline-|rounds-option-ten|winner-name-${USERNAME}x'
printf -- '- assertVisible:\n    id: "%s|%s"\n' "$good_ids" "$bad_ids" >"$TMP/ids-flow.yaml"
got="$(unknown_ids "$TMP/ids-flow.yaml" "$TMP/app" | sort | tr '\n' '|')"
want="$(tr '|' '\n' <<<"$bad_ids" | sort | tr '\n' '|')"
[ "$got" = "$want" ] \
  && ok "checker takes ids of testIds.ts helpers, flags misspelt, empty, wrong-typed and cut ones" || ko "checker takes helper ids" "flagged [$got] want [$want]"

# ── The boot flows find the app by testID ──
app_strings "$TMP/strings" "$CLIENT_APP"
[ "$(tr '\0' '\n' <"$TMP/strings" | grep -c .)" -gt 100 ] && ok "app strings read from Client/src/i18n" || ko "app strings read from Client/src/i18n"
for flow in $BOOT_FLOWS; do
  text_selectors "$MAESTRO_DIR/$flow" >"$TMP/selectors"
  hits="$(app_text_hits "$TMP/selectors" "$TMP/strings")"
  [ -z "$hits" ] && ok "$flow: no text selector matches app text" || ko "$flow: text selectors match app text" "$(tr '\t\n' ' ;' <<<"$hits")"
  missing="$(unknown_ids "$MAESTRO_DIR/$flow" "$CLIENT_APP")"
  [ -z "$missing" ] && ok "$flow: every id is in testIds.ts" || ko "$flow: ids missing from testIds.ts" "$(tr '\n' ' ' <<<"$missing")"
done
for flow in $ID_CHECKED_FLOWS; do
  missing="$(unknown_ids "$MAESTRO_DIR/$flow" "$CLIENT_APP")"
  [ -z "$missing" ] && ok "$flow: every id is in testIds.ts" || ko "$flow: ids missing from testIds.ts" "$(tr '\n' ' ' <<<"$missing")"
done
# The removal notice is the app's translated alert: its message, title and button are matched in both languages, so a
# change of wording fails here rather than as a device run waiting for a text that never shows
# Texts in the kick flows besides the removal alert: the raw server refusal and the system's default alert title
# (both asserted absent), and the iOS confirmation of a custom-scheme link
KICK_FLOW_OTHER_TEXTS='Removed by host
Alert
Open in Expose Me\\?|¿Abrir en Expose Me\\?
Open|Abrir'
# kick_notice_strays FLOW -> each text selector that is none of KICK_FLOW_OTHER_TEXTS nor the alert's title or button,
# so a removal notice one, and does not match kickedByHost in en and es (an assertNotVisible of it would pass vacuously)
kick_notice_strays() {
  text_selectors "$1" | cut -f2 | while IFS= read -r pattern; do
    grep -qxF -- "$pattern" <<<"$KICK_FLOW_OTHER_TEXTS" && continue
    matches_i18n "$pattern" serverNoticeTitle || matches_i18n "$pattern" ok || matches_i18n "$pattern" kickedByHost || echo "$pattern"
  done
}
cat >"$TMP/kick-flow.yaml" <<'EOF'
- extendedWaitUntil:
    visible: "(The host removed you from the room|El anfitrión te ha sacado de la sala).*"
- assertNotVisible: "Removed by host"
- assertVisible: "Notice|Aviso"
- assertNotVisible: "Alert"
- tapOn: "OK|Aceptar"
- assertNotVisible: "(The host kicked you out|El anfitrión te ha echado).*"
- assertNotVisible: "The host removed you from the room.*"
EOF
[ "$(kick_notice_strays "$TMP/kick-flow.yaml" | tr '\n' ';')" = "(The host kicked you out|El anfitrión te ha echado).*;The host removed you from the room.*;" ] \
  && ok "checker flags notice selectors of other wording or in one language, and only them" \
  || ko "checker flags stray notice selectors" "$(kick_notice_strays "$TMP/kick-flow.yaml" | tr '\n' ';')"
matches_i18n "The host removed you from the room.*" kickedByHost \
  && ko "checker takes a notice selector in English only" || ok "checker flags a notice selector in English only"
matches_i18n "(The host kicked you out|El anfitrión te ha echado).*" kickedByHost \
  && ko "checker takes a notice selector of other wording" || ok "checker flags a notice selector of other wording"
for flow in $KICK_NOTICE_FLOWS; do
  text_selectors "$MAESTRO_DIR/$flow" | cut -f2 >"$TMP/kick-selectors"
  for key in kickedByHost serverNoticeTitle ok; do
    found=""
    while IFS= read -r pattern; do matches_i18n "$pattern" "$key" && { found=$pattern; break; }; done <"$TMP/kick-selectors"
    [ -n "$found" ] && ok "$flow: reads the alert's $key in en and es ($found)" || ko "$flow: no text selector matches $key in en and es"
  done
  stale="$(kick_notice_strays "$MAESTRO_DIR/$flow")"
  [ -z "$stale" ] && ok "$flow: every removal notice selector matches kickedByHost in en and es" \
    || ko "$flow: removal notice selectors miss kickedByHost" "$stale"
done
# EXP-412: the unknown-link notice is the same kind of alert, read (or asserted absent mid-game) in both languages
for check in "unknown-link-home.yaml unknownLinkNotice serverNoticeTitle ok" "invite-link-mid-game.yaml unknownLinkNotice"; do
  read -r flow keys <<<"$check"
  text_selectors "$MAESTRO_DIR/$flow" | cut -f2 >"$TMP/notice-selectors"
  for key in $keys; do
    found=""
    while IFS= read -r pattern; do matches_i18n "$pattern" "$key" && { found=$pattern; break; }; done <"$TMP/notice-selectors"
    [ -n "$found" ] && ok "$flow: reads the alert's $key in en and es ($found)" || ko "$flow: no text selector matches $key in en and es"
  done
done
# EXP-417: server-unreachable.yaml's only text is the lobby's connection message, read in both languages
unreachable_texts="$(text_selectors "$MAESTRO_DIR/server-unreachable.yaml" | cut -f2)" stray=""
while IFS= read -r pattern; do matches_i18n "$pattern" serverUnreachable || stray+="$pattern;"; done <<<"$unreachable_texts"
[ -n "$unreachable_texts" ] && [ -z "$stray" ] && ok "server-unreachable.yaml: reads serverUnreachable in en and es" \
  || ko "server-unreachable.yaml: every text selector matches serverUnreachable in en and es" "${stray:-no text selector}"
# The bundle wait polls the app's testIDs in a loop bounded by a JS deadline: lab-play.test.sh checks lab.sh's
# STUCK_ATTEMPT_S against the longest `timeout: <ms>` of dev-client-boot.yaml, so that must be the loop's
loop_ms="$(grep -oE 'devClientBoot = \{ timeout: [0-9]+' "$BOOT" | grep -oE '[0-9]+$')"
longest_ms="$(grep -oE 'timeout: [0-9]+' "$BOOT" | grep -oE '[0-9]+$' | sort -n | tail -1)"
[ -n "$loop_ms" ] && [ "$loop_ms" = "$longest_ms" ] && grep -qF 'id: "join-game-button|initial-screen"' "$BOOT" \
  && ok "dev-client-boot.yaml: the bundle wait ($loop_ms ms) polls the app by testID and is the wait lab.sh budgets" \
  || ko "dev-client-boot.yaml: bundle wait timeout is its longest" "loop=$loop_ms longest=$longest_ms"
# The dev-client link turns off the dev-menu sheets that open over the app at launch: the onboarding (its "Continue"
# reads like the InitialScreen button) and the menu itself, which can open after the app's testIDs show and then take
# the onboarding taps (EXP-282)
link_params="$(sed -nE 's/^- openLink: "exp\+expose-me:\/\/expo-development-client\/\?([^"]*)"$/\1/p' "$BOOT" | tr '&' '\n')"
for param in 'url=${METRO_URL}' disableOnboarding=1 disableAutoLaunch=1 __expo_disable_auto_launch=1; do
  grep -qxF "$param" <<<"$link_params" && ok "dev-client-boot.yaml: the dev-client link carries $param" \
    || ko "dev-client-boot.yaml: openLink carries $param" "$(tr '\n' '&' <<<"$link_params")"
done

# ── hold-used-up.yaml and hold-closed.yaml check the hold button's text in both languages (EXP-176, EXP-354) ──
no_holds_left="$(i18n_value noHoldsLeft)"
for name in hold-used-up.yaml hold-closed.yaml; do # their ids are checked with ID_CHECKED_FLOWS
  HOLD_FLOW="$MAESTRO_DIR/$name"
  hold_texts="$(sed -nE 's/^[[:space:]]*text: "(.*)"$/\1/p' "$HOLD_FLOW" | sort -u)"
  # The only text filter, on the line after the hold button's id (the same selector)
  [ -n "$hold_texts" ] && [ "$hold_texts" = "$no_holds_left" ] \
    && grep -qF 'id: "hold-button"' <<<"$(grep -B1 -F "text: \"$no_holds_left\"" "$HOLD_FLOW")" \
    && ok "$name: the hold button's text filter is noHoldsLeft in en and es ($no_holds_left)" \
    || ko "$name: text filter is the hold button's noHoldsLeft in en|es" "app: $no_holds_left; flow: $(tr '\n' ';' <<<"$hold_texts")"
done

# ── device-host-start.yaml reads the remove-player confirmation and Start's "Starting…" in both languages (EXP-390) ──
# The app fills the confirmation's {name} with the highlighted "@<name>"; the flow removes bot3 (a bot id the Client's
# testIds test knows). Each key must be matched by one of the flow's text selectors in en and es, so a change of
# wording fails here rather than as a device run waiting for a text that never shows.
DEVICE_HOST_FLOW="$MAESTRO_DIR/device-host-start.yaml"
DEVICE_HOST_REMOVED="bot3"
# matches_i18n_named PATTERN KEY NAME -> like matches_i18n, with the string's {name} filled in with NAME
matches_i18n_named() {
  i18n_js "$CLIENT_APP" '
    const re = new RegExp(`^(?:${args[0]})$`, "is");
    const ok = (lang) => typeof lang[args[1]] === "string" && re.test(lang[args[1]].replace("{name}", args[2]));
    process.exit([en, es].every(ok) ? 0 : 1);
  ' "$1" "$2" "$3"
}
# flow_text_for FLOW KEY NAME -> the first text selector of FLOW that matches KEY (its {name} filled in) in en and es
# (text_selectors keeps YAML's double-quoted escapes: a regex's \? is written \\? in the flow)
flow_text_for() {
  local pattern
  while IFS= read -r pattern; do
    pattern="$(sed 's/\\\\/\\/g' <<<"$pattern")"
    matches_i18n_named "$pattern" "$2" "$3" && { echo "$pattern"; return 0; }
  done < <(text_selectors "$1" | cut -f2)
  return 1
}
# The checker itself: the name must be the one filled in, and a selector in one language only does not count
cat >"$TMP/named-flow.yaml" <<'EOF'
- assertVisible:
    text: "(Are you sure you want to remove|¿Seguro que quieres expulsar a) @bot3 (from the room|de la sala)\\?"
EOF
cat >"$TMP/named-en-flow.yaml" <<'EOF'
- assertVisible:
    text: "Are you sure you want to remove @bot3 from the room\\?"
EOF
flow_text_for "$TMP/named-flow.yaml" areYouSureRemove "@bot3" >/dev/null \
  && ok "checker takes a confirmation selector with the name filled in, in en and es" \
  || ko "checker takes a confirmation selector in en and es" "$(cat "$TMP/named-flow.yaml")"
flow_text_for "$TMP/named-flow.yaml" areYouSureRemove "@bot2" >/dev/null \
  && ko "checker takes a confirmation selector for another name" || ok "checker flags a confirmation selector for another name"
flow_text_for "$TMP/named-en-flow.yaml" areYouSureRemove "@bot3" >/dev/null \
  && ko "checker takes a confirmation selector in English only" || ok "checker flags a confirmation selector in English only"
for key in confirmRemovePlayer areYouSureRemove startingGame; do
  found="$(flow_text_for "$DEVICE_HOST_FLOW" "$key" "@$DEVICE_HOST_REMOVED")" \
    && ok "device-host-start.yaml: reads $key in en and es ($found)" \
    || ko "device-host-start.yaml: no text selector matches $key in en and es (name @$DEVICE_HOST_REMOVED)"
done
grep -qF "id: \"lobby-player-$DEVICE_HOST_REMOVED\"" "$DEVICE_HOST_FLOW" \
  && ok "device-host-start.yaml: removes the player its confirmation names ($DEVICE_HOST_REMOVED)" \
  || ko "device-host-start.yaml: taps lobby-player-$DEVICE_HOST_REMOVED"
# device-host-kick-mid-game.yaml (EXP-425): the same confirmation, opened from bot3's scoreboard row during the game;
# bots.mjs checks that same bot was removed (--expect-kick, documented in the flow's invocation)
DEVICE_HOST_KICK_FLOW="$MAESTRO_DIR/device-host-kick-mid-game.yaml"
for key in confirmRemovePlayer areYouSureRemove; do
  found="$(flow_text_for "$DEVICE_HOST_KICK_FLOW" "$key" "@$DEVICE_HOST_REMOVED")" \
    && ok "device-host-kick-mid-game.yaml: reads $key in en and es ($found)" \
    || ko "device-host-kick-mid-game.yaml: no text selector matches $key in en and es (name @$DEVICE_HOST_REMOVED)"
done
grep -qF "id: \"score-remove-$DEVICE_HOST_REMOVED\"" "$DEVICE_HOST_KICK_FLOW" \
  && grep -qF -- "--expect-kick $DEVICE_HOST_REMOVED" "$DEVICE_HOST_KICK_FLOW" \
  && ok "device-host-kick-mid-game.yaml: removes the player its confirmation names and the bots expect ($DEVICE_HOST_REMOVED)" \
  || ko "device-host-kick-mid-game.yaml: taps score-remove-$DEVICE_HOST_REMOVED and runs the bots with --expect-kick $DEVICE_HOST_REMOVED"

# ── Flow simulator ──
# maestro-sim.mjs runs a flow's own YAML and JS against a fake device with Maestro 2.11's semantics (see its header)
SIM="$HERE/maestro-sim.mjs"
sim() { # sim SCENARIO FLOW LABEL: one ok/ko per scenario line, or one ko with the simulator's error
  local out name verdict detail
  if ! out="$(node "$SIM" "$1" "$2" "$CLIENT_APP" 2>&1)"; then
    ko "$3: the simulator runs the flow" "$(tr '\n' ' ' <<<"$out")"; return
  fi
  while IFS=$'\t' read -r name verdict detail; do
    [ "$verdict" = ok ] && ok "$3: $name" || ko "$3: $name" "$detail"
  done <<<"$out"
}

# ── The launcher can't stretch the bundle wait (EXP-288) ──
# A launcher that comes back after the first server pick and then a download that stalls: the wait still ends on its
# own deadline, which lab.sh's STUCK_ATTEMPT_S budgets, instead of a fresh 120 s per pick
sim boot "$BOOT" "dev-client-boot.yaml"

# ── The onboarding language check survives a lost tap (EXP-282) ──
# On iOS a tap on the toggle can be swallowed (it55: by a system gesture window): each switch is retried, a bounded
# number of times, and the check still ends in the device language
sim toggle "$MAESTRO_DIR/open-app.yaml" "open-app.yaml"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
