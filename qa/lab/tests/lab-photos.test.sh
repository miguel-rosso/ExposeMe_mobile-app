#!/usr/bin/env bash
# `lab.sh photos` seeding is idempotent (EXP-202): argument parsing, lab file prefix, the adb/simctl commands it
# runs and the iOS seeded-marker logic, with stub swift/adb/xcrun and a fake simulator folder: no devices touched.
# Run: qa/lab/tests/lab-photos.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3] got [$2]"; fi; } # name, actual, expected

# shellcheck source=../lab.sh
source "$HERE/../lab.sh"
set +e

# ── Fake environment ──
RUNS="$TMP/runs"; DEVICES_JSON="$TMP/devices.json"; SIM_DEVICES_DIR="$TMP/sims"
CMDS="$TMP/cmds.log"
mkdir -p "$TMP/bin"
# swift stub: make-photos.swift <dir> <label> <count> <prefix> -> empty <prefix><label>-NN.jpg files
cat >"$TMP/bin/swift" <<'EOF'
#!/usr/bin/env bash
for ((i = 1; i <= $4; i++)); do : >"$2/$(printf '%s%s-%02d.jpg' "$5" "$3" "$i")"; done
EOF
chmod +x "$TMP/bin/swift"
export PATH="$TMP/bin:$PATH"
adbs() { echo "adb -s $*" >>"$CMDS"; }
XCRUN_FAIL=""   # simctl subcommand the stub makes fail (addmedia, boot, bootstatus)
xcrun() { # records the call; addmedia logs the base names it imports
  local sub=$2 f out
  if [ "$sub" = addmedia ]; then out="xcrun simctl addmedia $3"; shift 3; for f; do out+=" ${f##*/}"; done; echo "$out" >>"$CMDS"
  else echo "xcrun $*" >>"$CMDS"; fi
  [ "$sub" != "$XCRUN_FAIL" ]
}
new_sim() { # udid: a fake simulator folder (device.plist + photo library + an unrelated Media file)
  mkdir -p "$SIM_DEVICES_DIR/$1/data/Media/DCIM" "$SIM_DEVICES_DIR/$1/data/Media/PhotoData"
  : >"$SIM_DEVICES_DIR/$1/device.plist"; : >"$SIM_DEVICES_DIR/$1/data/Media/other-app-file"
}
log() { echo "[lab] $*" >>"$TMP/lab.log"; }
reset_log() { : >"$CMDS"; }
cmds_matching() { grep -c -- "$1" "$CMDS"; }

# ── parse_photos_args ──
parse_photos_args; check "no args -> default count, no reset" "$PHOTOS_N/$PHOTOS_RESET" "12/0"
parse_photos_args 20; check "N -> count" "$PHOTOS_N/$PHOTOS_RESET" "20/0"
parse_photos_args --reset 5; check "--reset N" "$PHOTOS_N/$PHOTOS_RESET" "5/1"
parse_photos_args 5 --reset; check "N --reset" "$PHOTOS_N/$PHOTOS_RESET" "5/1"
for bad in abc 0 -3 --wipe; do
  parse_photos_args "$bad" 2>/dev/null && ko "'$bad' is rejected" || ok "'$bad' is rejected"
done

# ── generate_lab_photos / lab_photos_from ──
dir="$TMP/gen"; mkdir -p "$dir"; : >"$dir/ios-a-01.jpg"   # leftover with the old (unprefixed) name
generate_lab_photos "$dir" ios-a 12
check "photos carry the lab prefix" "$(ls "$dir" | head -1)" "exposeme-lab-ios-a-01.jpg"
check "old leftovers are removed" "$(ls "$dir" | wc -l | tr -d ' ')" "12"
check "photos from #10" "$(lab_photos_from "$dir" 10 | xargs -n1 basename | tr '\n' ' ')" \
  "exposeme-lab-ios-a-10.jpg exposeme-lab-ios-a-11.jpg exposeme-lab-ios-a-12.jpg "
check "photos from #08 parse as decimal" "$(lab_photos_from "$dir" 8 | wc -l | tr -d ' ')" "5"

# ── ios_photo_plan ──
check "no marker -> add all" "$(ios_photo_plan "" 0 ios-a 12)" "add 1"
check "same label + count -> skip" "$(ios_photo_plan ios-a 12 ios-a 12)" "skip already has 12 photos"
check "more requested -> add the missing ones" "$(ios_photo_plan ios-a 12 ios-a 15)" "add 13"
[[ "$(ios_photo_plan ios-a 12 ios-a 5)" == "skip "*"--reset"* ]] && ok "fewer requested -> skip, suggest --reset" || ko "fewer requested -> skip"
[[ "$(ios_photo_plan ios-b 12 ios-a 12)" == "skip "*"--reset"* ]] && ok "other label -> skip, suggest --reset" || ko "other label -> skip"

# ── android_seed_photos ──
reset_log; : >"$TMP/lab.log"; android_seed_photos emulator-5554 "$dir" 0
check "android: clears the lab folder's photos (also pre-prefix ones), before the push" "$(head -1 "$CMDS")" \
  "adb -s emulator-5554 shell rm -f /sdcard/Pictures/ExposeMeQA/*.jpg"
check "android: pushes into the lab folder" "$(cmds_matching "push $dir/. /sdcard/Pictures/ExposeMeQA/")" "1"
check "android: media rescan last" "$(tail -1 "$CMDS")" \
  "adb -s emulator-5554 shell content call --method scan_volume --uri content://media --arg external_primary"
check "android: no recursive delete without --reset" "$(cmds_matching 'rm -rf')" "0"
check "android: deletes nothing outside the lab folder" "$(grep ' rm ' "$CMDS" | grep -vc '/sdcard/Pictures/ExposeMeQA')" "0"
check "android: no --reset line without --reset" "$(grep -c -- '--reset' "$TMP/lab.log" 2>/dev/null || true)" "0"
reset_log; android_seed_photos emulator-5554 "$dir" 1 android-a
check "android --reset: wipes the lab folder only" "$(head -1 "$CMDS")" "adb -s emulator-5554 shell rm -rf /sdcard/Pictures/ExposeMeQA"
# EXP-239: the deletion is reported per device
check "android --reset: logs the deleted lab folder with the device label" "$(tail -1 "$TMP/lab.log")" \
  "[lab] android-a: --reset: deleted the lab folder /sdcard/Pictures/ExposeMeQA"

# ── udid guard ──
udid=0A1B2C3D-0000-4000-8000-00000000000A; media="$SIM_DEVICES_DIR/$udid/data/Media"
new_sim "$udid"
is_sim_udid "$udid" && ok "UUID accepted" || ko "UUID accepted"
for bad in booted ../x "$udid/../x" ""; do
  is_sim_udid "$bad" && ko "'$bad' is not a udid" || ok "'$bad' is not a udid"
  reset_log; out="$(ios_seed_photos "$bad" "$TMP/p" ios-a 12 1)"; rc=$?
  [ $rc != 0 ] && [ ! -s "$CMDS" ] && ok "'$bad': refused before any simctl call" || ko "'$bad': refused before any simctl call" "rc=$rc $(cat "$CMDS")"
done
[ -e "$media/DCIM" ] && ok "bad udids deleted nothing" || ko "bad udids deleted nothing"
missing=0A1B2C3D-0000-4000-8000-0000000000FF
reset_log; out="$(ios_reset_photos "$missing")"; rc=$?
[ $rc != 0 ] && [[ "$out" == *"no simulator"* ]] && [ ! -s "$CMDS" ] && ok "UUID without device.plist -> refused" || ko "UUID without device.plist -> refused" "rc=$rc $out"

# ── ios_seed_photos ──
reset_log; out="$(ios_seed_photos $udid "$TMP/p" ios-a 12 0)"
check "ios 1st run: imports all 12" "$(grep -o 'exposeme-lab-ios-a-[0-9]*' "$CMDS" | wc -l | tr -d ' ')" "12"
check "ios 1st run: writes the marker" "$(cat "$media/$IOS_PHOTO_MARKER")" "ios-a 12"
reset_log; out="$(ios_seed_photos $udid "$TMP/p" ios-a 12 0)"
check "ios 2nd run: imports nothing" "$(cmds_matching addmedia)" "0"
check "ios 2nd run: says why" "$out" "already has 12 photos"
reset_log; ios_seed_photos $udid "$TMP/p" ios-a 15 0 >/dev/null
check "ios N 12 -> 15: imports only #13-#15" "$(cat "$CMDS")" \
  "xcrun simctl addmedia $udid exposeme-lab-ios-a-13.jpg exposeme-lab-ios-a-14.jpg exposeme-lab-ios-a-15.jpg"
check "ios N 12 -> 15: marker updated" "$(cat "$media/$IOS_PHOTO_MARKER")" "ios-a 15"
check "ios: no simulator restart without --reset" "$(cmds_matching shutdown)" "0"

reset_log; : >"$TMP/lab.log"; ios_seed_photos $udid "$TMP/p" ios-a 12 1 >/dev/null
check "ios --reset: shutdown, boot, wait, then import" "$(cut -d' ' -f1-3 "$CMDS" | tr '\n' ',')" \
  "xcrun simctl shutdown,xcrun simctl boot,xcrun simctl bootstatus,xcrun simctl addmedia,"
# EXP-239: the wipe and the reboot are reported per device
check "ios --reset: logs shutdown, deletion and reboot with the device label" "$(cat "$TMP/lab.log")" \
"[lab] ios-a: --reset: shutting down the simulator to delete its whole photo library
[lab] ios-a: --reset: photo library deleted, rebooting the simulator
[lab] ios-a: --reset: simulator rebooted with an empty photo library"
[ ! -e "$media/DCIM" ] && [ ! -e "$media/PhotoData" ] && ok "ios --reset: photo library deleted" || ko "ios --reset: photo library deleted"
[ -e "$media/other-app-file" ] && ok "ios --reset: rest of Media kept" || ko "ios --reset: rest of Media kept"
check "ios --reset: imports all 12 again" "$(grep -o 'exposeme-lab-ios-a-[0-9]*' "$CMDS" | wc -l | tr -d ' ')" "12"
check "ios --reset: marker rewritten" "$(cat "$media/$IOS_PHOTO_MARKER")" "ios-a 12"
# With lab.sh's own log (stdout) the progress lines must stay out of the captured result cmd_photos prints
out="$( log() { printf '[lab] %s\n' "$*"; }; ios_seed_photos $udid "$TMP/p" ios-a 12 1 2>"$TMP/progress")"
check "ios --reset: captured result is only the outcome" "$out" "added photos #1-#12"
check "ios --reset: progress lines go to stderr" "$(grep -c -- '--reset' "$TMP/progress")" "3"

# ── iOS failures: no marker, non-zero, reason printed ──
fresh=0A1B2C3D-0000-4000-8000-00000000000B; new_sim "$fresh"; fmarker="$SIM_DEVICES_DIR/$fresh/data/Media/$IOS_PHOTO_MARKER"
XCRUN_FAIL=addmedia; out="$(ios_seed_photos $fresh "$TMP/p" ios-a 12 0)"; rc=$?
[ $rc != 0 ] && [ ! -e "$fmarker" ] && [[ "$out" == *addmedia* ]] && ok "addmedia fails -> non-zero, no marker" || ko "addmedia fails -> non-zero, no marker" "rc=$rc out=$out"
XCRUN_FAIL=""; ios_seed_photos $fresh "$TMP/p" ios-a 12 0 >/dev/null
check "after a failed import the next run imports everything" "$(cat "$fmarker")" "ios-a 12"
for step in boot bootstatus; do
  XCRUN_FAIL=$step; reset_log; : >"$TMP/lab.log"; out="$(ios_seed_photos $fresh "$TMP/p" ios-a 12 1)"; rc=$?
  [ $rc != 0 ] && [ ! -e "$fmarker" ] && [ "$(cmds_matching addmedia)" = 0 ] \
    && ok "--reset with failing $step -> non-zero, no import, no marker" || ko "--reset with failing $step" "rc=$rc out=$out"
  grep -q "photo library deleted" "$TMP/lab.log" && ! grep -q "simulator rebooted" "$TMP/lab.log" \
    && ok "--reset with failing $step: deletion logged, no reboot claimed" || ko "--reset with failing $step: log" "$(cat "$TMP/lab.log")"
done
XCRUN_FAIL=""

# ── cmd_photos twice on both platforms ──
sim2=0A1B2C3D-0000-4000-8000-00000000000C; new_sim "$sim2"
echo "[{\"id\":\"$sim2\",\"label\":\"ios-b\",\"platform\":\"ios\"},{\"id\":\"emulator-5556\",\"label\":\"android-a\",\"platform\":\"android\"}]" >"$DEVICES_JSON"
mkdir -p "$RUNS/photos/bots"; : >"$RUNS/photos/bots/bot-01.jpg"   # old bot photo name
reset_log; (cmd_photos 4); (cmd_photos 4)
check "cmd_photos x2: iOS imported once" "$(cmds_matching "addmedia $sim2")" "1"
check "cmd_photos x2: Android clears the lab photos before each push" \
  "$(grep -E 'rm -f|push' "$CMDS" | awk '{print $4}' | tr '\n' ',')" "shell,push,shell,push,"
check "cmd_photos: bot photos regenerated without leftovers" "$(ls "$RUNS/photos/bots" | tr '\n' ' ')" \
  "exposeme-lab-bot-01.jpg exposeme-lab-bot-02.jpg exposeme-lab-bot-03.jpg exposeme-lab-bot-04.jpg "
(cmd_photos nope) 2>/dev/null && ko "cmd_photos: bad argument exits non-zero" || ok "cmd_photos: bad argument exits non-zero"
: >"$TMP/lab.log"; (cmd_photos 4 --reset)
grep -q "ios-b: --reset: simulator rebooted" "$TMP/lab.log" && grep -q "android-a: --reset: deleted the lab folder" "$TMP/lab.log" \
  && ok "cmd_photos --reset: reports the wipe on every device" || ko "cmd_photos --reset: reports the wipe on every device" "$(cat "$TMP/lab.log")"
sim3=0A1B2C3D-0000-4000-8000-00000000000D; new_sim "$sim3"
echo "[{\"id\":\"$sim3\",\"label\":\"ios-c\",\"platform\":\"ios\"}]" >"$DEVICES_JSON"
XCRUN_FAIL=addmedia; err="$( (cmd_photos 4) 2>&1 >/dev/null)"; rc=$?; XCRUN_FAIL=""
[ $rc != 0 ] && [[ "$err" == *"ios-c: simctl addmedia failed"* ]] && ok "cmd_photos: failed import -> non-zero + reason" || ko "cmd_photos: failed import -> non-zero + reason" "rc=$rc err=$err"
[ ! -e "$SIM_DEVICES_DIR/$sim3/data/Media/$IOS_PHOTO_MARKER" ] && ok "cmd_photos: failed import leaves no marker" || ko "cmd_photos: failed import leaves no marker"

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
