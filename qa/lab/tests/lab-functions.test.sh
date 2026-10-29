#!/usr/bin/env bash
# Unit tests for the toolchain helpers and `install` in qa/lab/lab.sh (no devices, builds or network).
# Run: qa/lab/tests/lab-functions.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# shellcheck source=../lab.sh
source "$HERE/../lab.sh"
set +e

# ── Fake environment ──
REAL_PATH="$PATH"
fake_node() { # dir, version: a `node` stub answering `node -p process.versions.node` (or anything) with version
  mkdir -p "$1"; printf '#!/bin/sh\necho %s\n' "$2" >"$1/node"; chmod +x "$1/node"
}
ROOT="$TMP/repo"; mkdir -p "$ROOT/Client"
# Only fake install locations are searched, so results don't depend on this machine
export NVM_DIR="$TMP/nvm" LAB_BREW_PREFIXES="$TMP/brew $TMP/usrlocal"
fake_node "$TMP/sys" 23.9.0   # default node: wrong major
for v in 22.14.0 24.3.0 24.18.0 25.1.0; do fake_node "$NVM_DIR/versions/node/v$v/bin" "$v"; done

# ── client_node_major ──
echo 24 >"$ROOT/Client/.nvmrc"
[ "$(client_node_major)" = 24 ] && ok "nvmrc '24' -> 24" || ko "nvmrc '24' -> 24"
echo v24.3.0 >"$ROOT/Client/.nvmrc"
[ "$(client_node_major)" = 24 ] && ok "nvmrc 'v24.3.0' -> 24" || ko "nvmrc 'v24.3.0' -> 24"
echo lts/iron >"$ROOT/Client/.nvmrc"
client_node_major >/dev/null 2>&1 && ko "unparseable nvmrc fails" || ok "unparseable nvmrc fails"
echo 24 >"$ROOT/Client/.nvmrc"

# ── client_path ──
PATH="$TMP/sys:$REAL_PATH"
out="$(client_path 2>/dev/null)"; rc=$?
[ $rc = 0 ] && [ "${out%%:*}" = "$NVM_DIR/versions/node/v24.18.0/bin" ] \
  && ok "wrong default node -> newest nvm v24 (not v22/v25)" || ko "wrong default node -> newest nvm v24" "rc=$rc out=${out%%:*}"

fake_node "$TMP/sys24" 24.11.0
PATH="$TMP/sys24:$REAL_PATH"
out="$(client_path 2>/dev/null)"
[ "$out" = "$PATH" ] && ok "matching default node -> PATH unchanged" || ko "matching default node -> PATH unchanged"

PATH="$TMP/sys:$REAL_PATH"
rm -rf "$NVM_DIR/versions/node/v24".*
fake_node "$TMP/usrlocal/opt/node@24/bin" 24.4.0
out="$(client_path 2>/dev/null)"
[ "${out%%:*}" = "$TMP/usrlocal/opt/node@24/bin" ] && ok "falls back to 2nd Homebrew prefix" || ko "falls back to 2nd Homebrew prefix" "${out%%:*}"
fake_node "$TMP/brew/opt/node@24/bin" 24.5.0
out="$(client_path 2>/dev/null)"
[ "${out%%:*}" = "$TMP/brew/opt/node@24/bin" ] && ok "prefers 1st Homebrew prefix" || ko "prefers 1st Homebrew prefix" "${out%%:*}"

rm -rf "$TMP/brew" "$TMP/usrlocal"
err="$(client_path 2>&1 >/dev/null)"; rc=$?
[ $rc != 0 ] && [[ "$err" == *"needs Node 24"* ]] \
  && ok "no Node 24 anywhere -> non-zero + clear message" || ko "no Node 24 anywhere -> fails loudly" "rc=$rc err=$err"
# Old behaviour silently accepted v22 here; make sure it is not picked
[[ "$(client_path 2>/dev/null)" != *v22* ]] && ok "does not settle for v22" || ko "does not settle for v22"
PATH="$REAL_PATH"

# ── client_node_min / client_path: Expo SDK 58 needs Node >= 24.3 even though .nvmrc only pins 24 (EXP-087) ──
[ "$(client_node_min)" = 24.3.0 ] && ok "nvmrc '24' -> minimum raised to Expo's 24.3.0" || ko "nvmrc '24' -> 24.3.0" "$(client_node_min)"
echo 24.5 >"$ROOT/Client/.nvmrc"
[ "$(client_node_min)" = 24.5.0 ] && ok "nvmrc '24.5' -> minimum 24.5.0 (above Expo's)" || ko "nvmrc '24.5' -> 24.5.0" "$(client_node_min)"
echo v24.1.0 >"$ROOT/Client/.nvmrc"
[ "$(client_node_min)" = 24.3.0 ] && ok "nvmrc 'v24.1.0' -> still Expo's 24.3.0" || ko "nvmrc 'v24.1.0' -> 24.3.0" "$(client_node_min)"
echo 26 >"$ROOT/Client/.nvmrc"
[ "$(client_node_min)" = 26.0.0 ] && ok "nvmrc '26' -> 26.0.0 (Expo's 24.x floor doesn't apply)" || ko "nvmrc '26' -> 26.0.0" "$(client_node_min)"
echo 24 >"$ROOT/Client/.nvmrc"
version_ge 24.10.0 24.3.0 && ok "version_ge compares numerically (24.10 >= 24.3)" || ko "version_ge 24.10.0 24.3.0"
version_ge 24.2.9 24.3.0 && ko "version_ge 24.2.9 < 24.3.0" || ok "version_ge 24.2.9 < 24.3.0"

fake_node "$TMP/sys2420" 24.2.0
for v in 24.1.0 24.2.1 24.3.0 24.6.0; do fake_node "$NVM_DIR/versions/node/v$v/bin" "$v"; done
PATH="$TMP/sys2420:$REAL_PATH"
out="$(client_path 2>/dev/null)"; rc=$?
[ $rc = 0 ] && [ "${out%%:*}" = "$NVM_DIR/versions/node/v24.6.0/bin" ] \
  && ok "default node 24.2.0 (too old for Expo) -> newest nvm 24.x >= 24.3" || ko "default 24.2.0 -> nvm 24.6.0" "rc=$rc out=${out%%:*}"
fake_node "$TMP/sys2430" 24.3.0
PATH="$TMP/sys2430:$REAL_PATH"
[ "$(client_path 2>/dev/null)" = "$PATH" ] && ok "default node exactly 24.3.0 -> PATH unchanged" || ko "default 24.3.0 accepted"
PATH="$TMP/sys2420:$REAL_PATH"
rm -rf "$NVM_DIR/versions/node/v24.3.0" "$NVM_DIR/versions/node/v24.6.0"
fake_node "$TMP/brew/opt/node@24/bin" 24.2.5    # 1st Homebrew prefix too old: skipped for the 2nd one
fake_node "$TMP/usrlocal/opt/node@24/bin" 24.4.0
out="$(client_path 2>/dev/null)"
[ "${out%%:*}" = "$TMP/usrlocal/opt/node@24/bin" ] && ok "too-old nvm and Homebrew 24.x skipped for one >= 24.3" || ko "skips too-old installs" "${out%%:*}"
rm -rf "$TMP/usrlocal"
err="$(client_path 2>&1 >/dev/null)"; rc=$?
[ $rc != 0 ] && [[ "$err" == *"needs Node 24 >= 24.3.0"* ]] && [[ "$err" == *"found node 24.2.0"* ]] \
  && ok "only Node 24.x < 24.3 installed -> non-zero, names the minimum and the node found" || ko "only too-old 24.x -> fails loudly" "rc=$rc err=$err"
rm -rf "$TMP/brew" "$NVM_DIR/versions/node"/v24.*
PATH="$REAL_PATH"

# ── pods_stale ──
client="$TMP/client"; ios="$client/ios"; mkdir -p "$ios"
old=202601010000 new=202601020000   # touch -t stamps: inputs older than the last pod install
for f in "$client/package.json" "$client/package-lock.json" "$ios/Podfile" "$ios/Podfile.properties.json"; do
  echo '{}' >"$f"; touch -t $old "$f"
done
printf 'PODS:\n  - ExpoImage\n' >"$ios/Podfile.lock"
pods_stale "$ios" && ok "Pods/ missing -> stale" || ko "Pods/ missing -> stale"
mkdir -p "$ios/Pods"
pods_stale "$ios" && ok "Manifest.lock missing -> stale" || ko "Manifest.lock missing -> stale"
cp "$ios/Podfile.lock" "$ios/Pods/Manifest.lock"; touch -t $new "$ios/Pods/Manifest.lock"
pods_stale "$ios" && ko "in sync -> not stale" || ok "in sync -> not stale"
for f in "$client/package.json" "$client/package-lock.json" "$ios/Podfile"; do
  touch -t 202601030000 "$f"
  pods_stale "$ios" && ok "$(basename "$f") newer than Manifest.lock -> stale" || ko "$(basename "$f") newer than Manifest.lock -> stale"
  touch -t $old "$f"
done
printf 'PODS:\n  - ExpoImage\n  - ExpoImageManipulator\n' >"$ios/Podfile.lock"; touch -t $old "$ios/Podfile.lock"
pods_stale "$ios" && ok "Podfile.lock differs from Manifest.lock -> stale" || ko "Podfile.lock differs -> stale"

# A JS-only dep bump: package.json is newer, pod install runs but leaves Manifest.lock (same content)
# untouched; pods_mark_installed must stop it from re-running on every build
cp "$ios/Podfile.lock" "$ios/Pods/Manifest.lock"; touch -t $new "$ios/Pods/Manifest.lock"
touch -t 202601030000 "$client/package.json"
pods_stale "$ios" && ok "JS-only package.json bump -> stale" || ko "JS-only package.json bump -> stale"
pods_mark_installed "$ios"
pods_stale "$ios" && ko "after install stamp -> not stale" "re-runs pod install forever" || ok "after install stamp -> not stale"
cmp -s "$ios/Podfile.lock" "$ios/Pods/Manifest.lock" && ok "stamp keeps Manifest.lock content" || ko "stamp keeps Manifest.lock content"

# ── cmd_install: a failed install is reported and fails the command, the other devices still get it (EXP-098) ──
STATE="$TMP/state"; DEVICES_JSON="$TMP/devices.json"; CMDS="$TMP/install-cmds.log"; mkdir -p "$STATE"
FAIL_ON=""   # device ids whose install the stubs make fail
xcrun() { echo "xcrun $*" >>"$CMDS"; ! { [ "$2" = install ] && [[ " $FAIL_ON " == *" $3 "* ]]; }; }
adbs() { echo "adb -s $*" >>"$CMDS"; ! { [ "$2" = install ] && [[ " $FAIL_ON " == *" $1 "* ]]; }; }
mkdir -p "$TMP/build/ExposeMe.app"; : >"$TMP/build/app-debug.apk"
echo "$TMP/build/ExposeMe.app" >"$STATE/ios-app-path"; echo "$TMP/build/app-debug.apk" >"$STATE/android-apk-path"
cat >"$DEVICES_JSON" <<'EOF'
[{"id":"SIM-A","label":"ios-a","platform":"ios"},{"id":"SIM-B","label":"ios-b","platform":"ios"},
 {"id":"emulator-5554","label":"android-a","platform":"android"},{"id":"emulator-5556","label":"android-b","platform":"android"}]
EOF
run_install() { : >"$CMDS"; out="$( (set -euo pipefail; cmd_install) 2>&1)"; rc=$?; } # sets out, rc

run_install
[ $rc = 0 ] && [ "$(grep -c "installed on" <<<"$out")" = 4 ] && ok "install: all succeed -> exit 0, every device reported" || ko "install: all succeed" "rc=$rc $out"

FAIL_ON="SIM-B emulator-5554"; run_install
[ $rc != 0 ] && ok "install: a failed install -> non-zero exit" || ko "install: a failed install -> non-zero exit" "rc=$rc"
! grep -q "installed on ios-b" <<<"$out" && ! grep -q "installed on android-a" <<<"$out" \
  && ok "install: failed devices are not reported as installed" || ko "install: failed devices not reported installed" "$out"
grep -q "ios-b: simctl install FAILED" <<<"$out" && grep -q "android-a: adb install FAILED" <<<"$out" \
  && ok "install: each failure is named per device" || ko "install: each failure named" "$out"
grep -q "installed on ios-a" <<<"$out" && grep -q "installed on android-b" <<<"$out" \
  && [ "$(grep -c ' install ' "$CMDS")" = 4 ] && ok "install: keeps going with the other devices" || ko "install: keeps going" "$out"
[[ "$(tail -1 <<<"$out")" == *"install failed on: ios-b android-a"* ]] && ok "install: final line lists the failed devices" || ko "install: final summary" "$out"
grep -q "pm grant" "$CMDS" && ok "install: Android permissions granted despite a failure" || ko "install: permissions granted despite a failure"
grep -q "privacy SIM-B" "$CMDS" && ko "install: no photo grant on a failed iOS install" || ok "install: no photo grant on a failed iOS install"

FAIL_ON=""; rm "$STATE/android-apk-path"; run_install
[ $rc = 0 ] && grep -q "android-a: skipped, no Android build" <<<"$out" && ! grep -q "installed on android" <<<"$out" \
  && [ "$(grep -c "adb -s .* install " "$CMDS")" = 0 ] && ok "install: no Android build -> skipped, not reported installed" || ko "install: no Android build -> skipped" "rc=$rc $out"

# ── cmd_open: boots the dev client like dev-client-boot.yaml (EXP-313) ──
# Its link carries the same flags as the flow's openLink (no dev-menu onboarding sheet, no dev menu at launch), with
# local Metro as the url, and Android cold-starts the app with it: a running dev client can drop the link (EXP-296)
boot_link="$(sed -nE 's/^- openLink: "(.*)"$/\1/p' "$HERE/../../maestro/dev-client-boot.yaml")"
[ -n "$boot_link" ] && [ "$DEV_CLIENT_URL" = "${boot_link//'${METRO_URL}'/http%3A%2F%2Flocalhost%3A$METRO_PORT}" ] \
  && ok "open: same dev-client link as dev-client-boot.yaml, pointed at local Metro" \
  || ko "open: same dev-client link as dev-client-boot.yaml" "lab.sh=$DEV_CLIENT_URL flow=$boot_link"
: >"$CMDS"; out="$( (set -euo pipefail; cmd_open) 2>&1)"; rc=$?
android_open_cmds="$(grep '^adb -s emulator-5556 ' "$CMDS")"
[ $rc = 0 ] && [ "$android_open_cmds" = "$(printf '%s\n' "adb -s emulator-5556 shell am force-stop $APP_ID" \
  "adb -s emulator-5556 shell am start -a android.intent.action.VIEW -d '$DEV_CLIENT_URL'")" ] \
  && ok "open: Android stops the app, then the link cold-starts it" || ko "open: Android cold start via the link" "rc=$rc $(tr '\n' ';' <"$CMDS")"
grep -qxF "xcrun simctl openurl SIM-A $DEV_CLIENT_URL" "$CMDS" && ! grep -q "terminate" "$CMDS" \
  && ok "open: iOS opens the link (it handles it on a running app)" || ko "open: iOS opens the link" "$(tr '\n' ';' <"$CMDS")"

# ── prebuild_stale / build --prebuild (EXP-255, EXP-086): app.json & co. only reach the binaries via expo prebuild ──
ROOT="$TMP/prebuild-repo"; RUNS="$TMP/prebuild-runs"; STATE="$RUNS/.lab"; mkdir -p "$ROOT/Client" "$STATE"
echo '{"expo":{"name":"ExposeMe"}}' >"$ROOT/Client/app.json"; echo '{"name":"client"}' >"$ROOT/Client/package.json"
prebuild_stale ios && ok "never prebuilt by the lab -> stale" || ko "never prebuilt -> stale"
prebuild_mark_done ios
prebuild_stale ios && ko "just prebuilt -> not stale" || ok "just prebuilt -> not stale"
prebuild_stale android && ok "prebuild of one platform doesn't cover the other" || ko "per-platform prebuild record"
for change in "app.json:{\"expo\":{\"name\":\"ExposeMe\",\"version\":\"2\"}}" "package.json:{\"name\":\"client\",\"deps\":1}" \
  "plugins/withFoo.js:module.exports = 1" "app.config.js:module.exports = {}"; do
  f="$ROOT/Client/${change%%:*}"; mkdir -p "$(dirname "$f")"; echo "${change#*:}" >"$f"
  prebuild_stale ios && ok "${change%%:*} changed/added -> stale" || ko "${change%%:*} changed -> stale"
  prebuild_mark_done ios
done
echo "module.exports = 2" >"$ROOT/Client/plugins/withFoo.js"
prebuild_stale ios && ok "config plugin file edited -> stale" || ko "config plugin edited -> stale"
prebuild_mark_done ios; touch "$ROOT/Client/app.json"
prebuild_stale ios && ko "only the mtime changed -> not stale" || ok "only the mtime changed -> not stale"
# Icons and splash images that app.json points to are copied into the native projects by prebuild
mkdir -p "$ROOT/Client/assets/images"
echo icon-v1 >"$ROOT/Client/assets/images/icon.png"; echo splash-v1 >"$ROOT/Client/assets/images/splash-icon.png"
echo unused-v1 >"$ROOT/Client/assets/images/unused.png"
echo '{"expo":{"icon":"./assets/images/icon.png","plugins":[["expo-splash-screen",{"image":"./assets/images/splash-icon.png"}]],"android":{"adaptiveIcon":{"foregroundImage":"./assets/images/missing.png"}}}}' \
  >"$ROOT/Client/app.json"
[ "$(app_json_files | sed "s|$ROOT/Client/||" | tr '\n' ' ')" = "assets/images/icon.png assets/images/splash-icon.png " ] \
  && ok "app_json_files: the existing ./ paths app.json points to" || ko "app_json_files" "$(app_json_files)"
prebuild_mark_done ios
echo splash-v2 >"$ROOT/Client/assets/images/splash-icon.png"
prebuild_stale ios && ok "splash image app.json points to changed -> stale" || ko "splash image changed -> stale"
prebuild_mark_done ios; echo icon-v2 >"$ROOT/Client/assets/images/icon.png"
prebuild_stale ios && ok "icon app.json points to changed -> stale" || ko "icon changed -> stale"
prebuild_mark_done ios; echo unused-v2 >"$ROOT/Client/assets/images/unused.png"
prebuild_stale ios && ko "image app.json doesn't use changed -> not stale" || ok "image app.json doesn't use changed -> not stale"

# cmd_build with stub npx and stubbed native builds: arguments, prebuild with the Client's Node, warnings
fake_node "$TMP/node24" 24.18.0
printf '#!/bin/sh\necho "$(pwd) CI=$CI node=$(node) $*" >>"%s"\nexit "${STUB_NPX_RC:-0}"\n' "$TMP/npx.log" >"$TMP/node24/npx"; chmod +x "$TMP/node24/npx"
client_path() { echo "$TMP/node24:$REAL_PATH"; }
build_ios() { echo "build_ios" >>"$TMP/builds.log"; }
build_android() { echo "build_android" >>"$TMP/builds.log"; }
cmd_install() { echo "install" >>"$TMP/builds.log"; }
run_build() { rm -f "$TMP/npx.log" "$TMP/builds.log"; out="$( (set -euo pipefail; cmd_build "$@") 2>&1)"; rc=$?; } # sets out, rc
rm -f "$STATE"/prebuild-hash-*; mkdir -p "$ROOT/Client/ios" "$ROOT/Client/android"

run_build android
[ $rc = 0 ] && [ ! -e "$TMP/npx.log" ] && grep -q "Client/android may be out of date.*lab.sh build android --prebuild" <<<"$out" \
  && [ "$(cat "$TMP/builds.log")" = "$(printf 'build_android\ninstall')" ] \
  && ok "build android without a lab prebuild -> warns with the command, still builds" || ko "build: unknown prebuild warns" "rc=$rc $out"
run_build android --prebuild
[ $rc = 0 ] && [ "$(cat "$TMP/npx.log")" = "$ROOT/Client CI=1 node=24.18.0 expo prebuild --no-install --platform android" ] \
  && [ "$(cat "$TMP/builds.log")" = "$(printf 'build_android\ninstall')" ] \
  && ok "build android --prebuild -> CI=1 expo prebuild --no-install on the Client's Node, then builds" || ko "build --prebuild runs prebuild" "rc=$rc $out $(cat "$TMP/npx.log" 2>/dev/null)"
run_build android
[ $rc = 0 ] && ! grep -q "out of date" <<<"$out" && [ ! -e "$TMP/npx.log" ] && ok "after the prebuild -> no warning, no prebuild" || ko "after prebuild no warning" "$out"
echo '{"expo":{"name":"ExposeMe","version":"3"}}' >"$ROOT/Client/app.json"
run_build android
grep -q "Client/android may be out of date" <<<"$out" && ok "app.json changed after the prebuild -> warns" || ko "app.json changed -> warns" "$out"
run_build --prebuild
[ "$(cat "$TMP/npx.log" 2>/dev/null)" = "$ROOT/Client CI=1 node=24.18.0 expo prebuild --no-install --platform all" ] \
  && ! prebuild_stale ios && ! prebuild_stale android && [ "$(cat "$TMP/builds.log")" = "$(printf 'build_ios\nbuild_android\ninstall')" ] \
  && ok "build --prebuild (all) -> one prebuild for both platforms, both recorded" || ko "build --prebuild all" "$out"
rm -rf "$ROOT/Client/ios"
run_build ios
grep -q "Client/ios does not exist yet: running expo prebuild first" <<<"$out" && grep -q -- "--platform ios" "$TMP/npx.log" \
  && ok "no native project yet -> prebuilds it automatically" || ko "missing native dir -> auto prebuild" "$out"
STUB_NPX_RC=1; export STUB_NPX_RC; run_build ios --prebuild; unset STUB_NPX_RC
[ $rc != 0 ] && grep -q "expo prebuild FAILED" <<<"$out" && [ ! -e "$TMP/builds.log" ] \
  && ok "prebuild fails -> non-zero, nothing built or installed" || ko "prebuild failure stops the build" "rc=$rc $out"
run_build tvos
[ $rc != 0 ] && grep -q "usage: build" <<<"$out" && [ ! -e "$TMP/builds.log" ] && ok "build: bad argument rejected" || ko "build: bad argument" "rc=$rc $out"
build_android() { echo "build_android" >>"$TMP/builds.log"; return 1; }
run_build
[ $rc != 0 ] && grep -q install "$TMP/builds.log" && ok "build: a failed platform build -> non-zero, still installs the rest" || ko "build: failed platform" "rc=$rc"

# ── server: lifts every /upload in-flight cap for bots (they all share one IP) ──
for knob in $(grep -o 'envInt("UPLOAD_INFLIGHT_[A-Z_]*"' "$HERE/../../../Server/middlewares/uploadInFlight.ts" | cut -d'"' -f2); do
  grep -q "$knob=\"\${$knob:-10000}\"" "$HERE/../lab.sh" && ok "server: lifts $knob" || ko "server: lifts $knob"
done

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
