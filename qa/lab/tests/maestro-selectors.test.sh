#!/usr/bin/env bash
# The boot flows find the app by testID, never by its translated text (EXP-048): open-app.yaml and its
# dev-client-boot.yaml subflow may only use text for the Expo dev-client UI and system alerts, or to check the
# language of an element already matched by id. A text selector that matches any app string (Client/app/i18n) breaks
# in other languages and can hit the app instead of the dev menu. Static: no devices, servers or network.
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

# app_strings OUT -> every en/es string of the app, NUL-separated
app_strings() {
  node -e '
    const fs = require("fs");
    const load = (f) => new Function(fs.readFileSync(f, "utf8").replace(/^export default/m, "return").replace(/\}\s*as const;\s*$/, "}"))();
    const values = process.argv.slice(1).flatMap((f) => Object.values(load(f))).filter((v) => typeof v === "string");
    process.stdout.write(values.join("\0"));
  ' "$2/i18n/en.ts" "$2/i18n/es.ts" >"$1"
}

# app_text_hits SELECTORS STRINGS -> "<line>\t<pattern>\t<app string>" for each selector that matches an app string
# (Maestro matches the whole text, also with line breaks read as spaces)
app_text_hits() {
  perl -e '
    my ($selectors, $strings) = @ARGV;
    open my $fh, "<", $strings or die; local $/; my @app = split /\0/, <$fh>; close $fh;
    open $fh, "<", $selectors or die; $/ = "\n";
    while (<$fh>) {
      chomp; my ($line, $pattern) = split /\t/, $_, 2;
      my $re = eval { qr/^(?:$pattern)\z/ } or next;
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
    while (my $id = <$fh>) { chomp $id; my $re = qr/^(?:$id)\z/; print "$id\n" unless grep { $_ =~ $re } @known }
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
EOF
app_strings "$TMP/strings" "$TMP/app"
text_selectors "$TMP/flow.yaml" >"$TMP/selectors"
app_text_hits "$TMP/selectors" "$TMP/strings" >"$TMP/hits"
for hit in "2	This is the developer menu.*|Join Game	Join Game" "11	Unirse a Partida	Unirse a Partida" \
  "12	Continue	Continue" "17	YOUR GALLERY IS THE GAME	YOUR GALLERY\\nIS THE GAME"; do
  grep -qxF "$hit" "$TMP/hits" && ok "checker flags: ${hit//	/ -> }" || ko "checker flags: ${hit//	/ -> }" "$(cat "$TMP/hits")"
done
[ "$(wc -l <"$TMP/hits" | tr -d ' ')" = 4 ] \
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
# The dev-menu onboarding sheet never shows, so its "Continue" (also the InitialScreen button) is never tapped
grep -qE '^- openLink: "exp\+expose-me://expo-development-client/\?url=\$\{METRO_URL\}(&[^"]*)?&disableOnboarding=1(&[^"]*)?"$' "$BOOT" \
  && ok "dev-client-boot.yaml: the dev-client link disables the dev-menu onboarding" || ko "dev-client-boot.yaml: openLink carries disableOnboarding=1"

# ── The launcher can't hang the bundle wait ──
# Runs the loop's own JS (dev-client-boot.yaml) with a launcher that keeps coming back and an app that never loads:
# each server pick restarts the deadline, so the picks must be capped for the loop to end
picks="$(node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
  const script = (re) => { const l = lines.find((x) => re.test(x)); if (!l) throw new Error("missing " + re); return l.match(/\$\{(.*)\}"?$/)[1]; };
  const launcher = lines.findIndex((l) => /visible: "Development servers/.test(l));
  const pickCondition = lines[launcher - 1].match(/true: \$\{(.*)\}$/)[1];
  const end = lines.findIndex((l, i) => i > launcher && /^- /.test(l));
  const pickScripts = lines.slice(launcher, end).filter((l) => /evalScript: \$\{/.test(l)).map((l) => l.match(/\$\{(.*)\}$/)[1]);
  let now = 0;
  const output = {};
  const Clock = { now: () => now };
  const run = (js) => new Function("output", "Date", `"use strict"; return (${js});`)(output, Clock);
  run(script(/evalScript: "\$\{output\.devClientBoot = /));
  run(script(/evalScript: \$\{output\.devClientBoot\.deadline = /));
  const whileCondition = lines[lines.findIndex((l) => /^    while:/.test(l)) + 1].match(/true: \$\{(.*)\}$/)[1];
  let picks = 0;
  for (let i = 0; i < 10000 && run(whileCondition); i++) {
    if (run(pickCondition)) { pickScripts.forEach(run); picks++; }
    now += 1000;
  }
  console.log(run(whileCondition) ? "hangs" : picks + " " + output.devClientBoot.maxServerPicks);
' "$BOOT" 2>&1)"
read -r picked max <<<"$picks"
[ -n "${max:-}" ] && [ "$picked" = "$max" ] && [ "$max" -ge 1 ] && [ "$max" -le 2 ] \
  && ok "dev-client-boot.yaml: a launcher that keeps coming back is picked $picked times, then the wait ends" \
  || ko "dev-client-boot.yaml: server picks capped at <= 2" "$picks"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
