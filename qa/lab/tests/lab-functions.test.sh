#!/usr/bin/env bash
# Unit tests for the toolchain helpers in qa/lab/lab.sh (no devices, builds or network).
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
fake_node() { # dir, version: a `node` stub answering `node -p ...` with the major of version
  mkdir -p "$1"; printf '#!/bin/sh\necho %s\n' "${2%%.*}" >"$1/node"; chmod +x "$1/node"
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

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
