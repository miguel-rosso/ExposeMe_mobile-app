#!/usr/bin/env bash
# The boot flows find the app by testID, never by its translated text (EXP-048): open-app.yaml and its
# dev-client-boot.yaml subflow may only use text for the Expo dev-client UI and system alerts, or to check the
# language of an element already matched by id. A text selector that matches any app string (Client/app/i18n) breaks
# in other languages and can hit the app instead of the dev menu. hold-used-up.yaml filters the hold button by its
# noHoldsLeft text: in both languages, as the app has it (EXP-176). Static: no devices, servers or network.
# Run: qa/lab/tests/maestro-selectors.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_DIR="${MAESTRO_DIR:-$HERE/../../maestro}"
CLIENT_APP="$HERE/../../../Client/app"
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

# unknown_ids FLOW -> each alternative of an `id:` selector that matches no testID in Client/app/utils/testIds.ts
unknown_ids() {
  grep -oE '^[[:space:]]*id: "[^"]*"' "$1" | sed -E 's/.*id: "(.*)"/\1/' | tr '|' '\n' | sort -u >"$TMP/ids"
  grep -oE '"[a-z0-9-]+"' "$2/utils/testIds.ts" | tr -d '"' >"$TMP/known-ids"
  perl -e '
    open my $fh, "<", $ARGV[1] or die; chomp(my @known = <$fh>); close $fh;
    open $fh, "<", $ARGV[0] or die;
    while (my $id = <$fh>) { chomp $id; my $re = qr/\A(?:$id)\z/ism; print "$id\n" unless grep { $_ =~ $re } @known }
  ' "$TMP/ids" "$TMP/known-ids"
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

# ── The boot flows find the app by testID ──
app_strings "$TMP/strings" "$CLIENT_APP"
[ "$(tr '\0' '\n' <"$TMP/strings" | grep -c .)" -gt 100 ] && ok "app strings read from Client/app/i18n" || ko "app strings read from Client/app/i18n"
for flow in $BOOT_FLOWS; do
  text_selectors "$MAESTRO_DIR/$flow" >"$TMP/selectors"
  hits="$(app_text_hits "$TMP/selectors" "$TMP/strings")"
  [ -z "$hits" ] && ok "$flow: no text selector matches app text" || ko "$flow: text selectors match app text" "$(tr '\t\n' ' ;' <<<"$hits")"
  missing="$(unknown_ids "$MAESTRO_DIR/$flow" "$CLIENT_APP")"
  [ -z "$missing" ] && ok "$flow: every id is in testIds.ts" || ko "$flow: ids missing from testIds.ts" "$(tr '\n' ' ' <<<"$missing")"
done
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

# ── hold-used-up.yaml checks the hold button's text in both languages (EXP-176) ──
HOLD_FLOW="$MAESTRO_DIR/hold-used-up.yaml"
missing="$(unknown_ids "$HOLD_FLOW" "$CLIENT_APP")"
[ -z "$missing" ] && ok "hold-used-up.yaml: every id is in testIds.ts" || ko "hold-used-up.yaml: ids missing from testIds.ts" "$(tr '\n' ' ' <<<"$missing")"
no_holds_left="$(i18n_value noHoldsLeft)"
hold_texts="$(sed -nE 's/^[[:space:]]*text: "(.*)"$/\1/p' "$HOLD_FLOW" | sort -u)"
# The only text filter, on the line after the hold button's id (the same selector)
[ -n "$hold_texts" ] && [ "$hold_texts" = "$no_holds_left" ] \
  && grep -B1 -F "text: \"$no_holds_left\"" "$HOLD_FLOW" | grep -qF 'id: "hold-button"' \
  && ok "hold-used-up.yaml: the hold button's text filter is noHoldsLeft in en and es ($no_holds_left)" \
  || ko "hold-used-up.yaml: text filter is the hold button's noHoldsLeft in en|es" "app: $no_holds_left; flow: $(tr '\n' ';' <<<"$hold_texts")"

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
