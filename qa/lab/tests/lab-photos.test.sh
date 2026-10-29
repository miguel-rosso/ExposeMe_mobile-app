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
REAL_SWIFT="$(command -v swift || true)"   # the real generator is checked at the end
mkdir -p "$TMP/bin"
# swift stub: make-photos.swift <dir> <label> <count> <prefix> -> empty <prefix><label>-NN.jpg files;
# make-photos.swift --edge <dir> <label> <prefix> -> empty <prefix><label>-edge-<kind>.jpg files
cat >"$TMP/bin/swift" <<'EOF'
#!/usr/bin/env bash
if [ "$2" = --edge ]; then for k in big-portrait big-landscape exif-rotated; do : >"$3/$5$4-edge-$k.jpg"; done; exit 0; fi
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
check "no --edge -> no edge-case photos" "$PHOTOS_EDGE" "0"
parse_photos_args --edge 3 --reset; check "--edge N --reset" "$PHOTOS_N/$PHOTOS_RESET/$PHOTOS_EDGE" "3/1/1"
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

# ── generate_edge_photos / lab_edge_photos (EXP-083) ──
generate_edge_photos "$dir" ios-a; generate_edge_photos "$dir" ios-a
check "edge-case photos: added next to the numbered ones, once" "$(ls "$dir" | wc -l | tr -d ' ')" "15"
check "edge-case photos are listed by name" "$(lab_edge_photos "$dir" | xargs -n1 basename | tr '\n' ' ')" \
  "exposeme-lab-ios-a-edge-big-landscape.jpg exposeme-lab-ios-a-edge-big-portrait.jpg exposeme-lab-ios-a-edge-exif-rotated.jpg "
check "numbered photos from #1 leave the edge-case ones out" "$(lab_photos_from "$dir" 1 | grep -c edge)" "0"
check "numbered photos from #1 are all 12" "$(lab_photos_from "$dir" 1 | wc -l | tr -d ' ')" "12"

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

# ── ios_seed_edge_photos (EXP-083) ──
esim=0A1B2C3D-0000-4000-8000-00000000000E; new_sim "$esim"; emarker="$SIM_DEVICES_DIR/$esim/data/Media/$IOS_EDGE_MARKER"
XCRUN_FAIL=addmedia; out="$(ios_seed_edge_photos $esim "$TMP/pe" ios-e)"; rc=$?; XCRUN_FAIL=""
[ $rc != 0 ] && [ ! -e "$emarker" ] && [[ "$out" == *addmedia* ]] && ok "edge addmedia fails -> non-zero, no marker" || ko "edge addmedia fails -> non-zero, no marker" "rc=$rc out=$out"
ios_seed_photos $esim "$TMP/pe" ios-e 4 0 >/dev/null
reset_log; out="$(ios_seed_edge_photos $esim "$TMP/pe" ios-e)"
check "ios edge 1st run: imports only the 3 edge-case photos" "$(cat "$CMDS")" \
  "xcrun simctl addmedia $esim exposeme-lab-ios-e-edge-big-landscape.jpg exposeme-lab-ios-e-edge-big-portrait.jpg exposeme-lab-ios-e-edge-exif-rotated.jpg"
check "ios edge 1st run: says so" "$out" "added 3 edge-case photos"
check "ios edge: numbered photos kept in the folder" "$(lab_photos_from "$TMP/pe" 1 | wc -l | tr -d ' ')" "4"
reset_log; out="$(ios_seed_edge_photos $esim "$TMP/pe" ios-e)"
check "ios edge 2nd run: imports nothing" "$(cmds_matching addmedia)" "0"
check "ios edge 2nd run: says why" "$out" "edge-case photos already added"
check "ios edge: numbered marker untouched" "$(cat "$SIM_DEVICES_DIR/$esim/data/Media/$IOS_PHOTO_MARKER")" "ios-e 4"
ios_reset_photos $esim ios-e 2>/dev/null
[ ! -e "$emarker" ] && ok "ios --reset forgets the edge-case photos too" || ko "ios --reset forgets the edge-case photos too"
reset_log; ios_seed_edge_photos $esim "$TMP/pe" ios-e >/dev/null
check "ios edge after --reset: imports them again" "$(grep -o 'edge-[a-z-]*.jpg' "$CMDS" | wc -l | tr -d ' ')" "3"
reset_log; out="$(ios_seed_edge_photos ../x "$TMP/pe" ios-e)"; rc=$?
[ $rc != 0 ] && [ ! -s "$CMDS" ] && ok "ios edge: bad udid refused before any simctl call" || ko "ios edge: bad udid refused" "rc=$rc $out"

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

# ── cmd_photos --edge (EXP-083) ──
sim4=0A1B2C3D-0000-4000-8000-00000000000F; new_sim "$sim4"
echo "[{\"id\":\"$sim4\",\"label\":\"ios-d\",\"platform\":\"ios\"},{\"id\":\"emulator-5558\",\"label\":\"android-b\",\"platform\":\"android\"}]" >"$DEVICES_JSON"
reset_log; (cmd_photos 2 --edge); (cmd_photos 2 --edge)
check "cmd_photos --edge x2: iOS imports the numbered and the edge-case photos once each" "$(cmds_matching "addmedia $sim4")" "2"
check "cmd_photos --edge: Android pushes numbered + edge-case photos" "$(ls "$RUNS/photos/android-b" | tr '\n' ' ')" \
  "exposeme-lab-android-b-01.jpg exposeme-lab-android-b-02.jpg exposeme-lab-android-b-edge-big-landscape.jpg exposeme-lab-android-b-edge-big-portrait.jpg exposeme-lab-android-b-edge-exif-rotated.jpg "
check "cmd_photos --edge: bots get the edge-case photos too" "$(ls "$RUNS/photos/bots" | grep -c -- '-edge-')" "3"
(cmd_photos 2)
check "cmd_photos without --edge: Android folder back to the numbered photos" "$(ls "$RUNS/photos/android-b" | grep -c -- '-edge-')" "0"
check "cmd_photos without --edge: bots without edge-case photos" "$(ls "$RUNS/photos/bots" | grep -c -- '-edge-')" "0"

# ── make-photos.swift --edge, the real generator (EXP-083): sizes and EXIF orientation ──
exif_orientation() { # jpeg -> the IFD0 Orientation tag, or "none"
  python3 -I - "$1" <<'PY'
import struct, sys
data = open(sys.argv[1], "rb").read()
i = 2
while i + 4 <= len(data) and data[i] == 0xFF:
    marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
    if marker == 0xE1 and data[i + 4:i + 10] == b"Exif\0\0":
        tiff = data[i + 10:i + 2 + length]
        e = "<" if tiff[:2] == b"II" else ">"
        ifd = struct.unpack(e + "I", tiff[4:8])[0]
        for k in range(struct.unpack(e + "H", tiff[ifd:ifd + 2])[0]):
            entry = ifd + 2 + 12 * k
            if struct.unpack(e + "H", tiff[entry:entry + 2])[0] == 0x0112:
                print(struct.unpack(e + "H", tiff[entry + 8:entry + 10])[0]); sys.exit()
    if marker == 0xDA: break
    i += 2 + length
print("none")
PY
}
pixel_size() { sips -g pixelWidth -g pixelHeight "$1" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "x" h}'; }
if [ -z "$REAL_SWIFT" ] || ! command -v sips >/dev/null || ! command -v python3 >/dev/null; then
  echo "skip - make-photos.swift --edge (needs swift, sips and python3: macOS)"
else
  gen="$TMP/real-edge"
  if "$REAL_SWIFT" "$HERE/../make-photos.swift" --edge "$gen" ios-a "$LAB_PHOTO_PREFIX" >/dev/null; then
    p="$gen/${LAB_PHOTO_PREFIX}ios-a-edge"
    check "real --edge: 3 photos" "$(ls "$gen" | wc -l | tr -d ' ')" "3"
    check "real --edge: big portrait is 3024x4032" "$(pixel_size "$p-big-portrait.jpg")" "3024x4032"
    check "real --edge: big landscape is 4032x3024" "$(pixel_size "$p-big-landscape.jpg")" "4032x3024"
    check "real --edge: EXIF-rotated photo stores sideways pixels" "$(pixel_size "$p-exif-rotated.jpg")" "4032x3024"
    check "real --edge: EXIF-rotated photo carries Orientation=6" "$(exif_orientation "$p-exif-rotated.jpg")" "6"
    check "real --edge: upright photos carry Orientation=1" \
      "$(exif_orientation "$p-big-portrait.jpg")/$(exif_orientation "$p-big-landscape.jpg")" "1/1"
    # Bots upload them as they are: they must fit the server's 5 MB upload cap (Server/middlewares/upload.ts)
    check "real --edge: every photo under 5 MB" "$(find "$gen" -name '*.jpg' -size +5120k | wc -l | tr -d ' ')" "0"
  else ko "real --edge: generator ran"; fi
  "$REAL_SWIFT" "$HERE/../make-photos.swift" --edge 2>/dev/null && ko "real --edge without a folder exits non-zero" || ok "real --edge without a folder exits non-zero"
fi

echo "# $pass passed, $fail failed"
[ $fail = 0 ]
