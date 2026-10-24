---
name: exposeme-device-lab
description: How to run ExposeMe locally on several iOS simulators and Android emulators at once, seed their galleries with labelled photos, and play real multiplayer games (Maestro + socket bots). Use whenever you need to run the app, test on devices, take screenshots, or measure sync/lag.
---

# ExposeMe device lab

Everything goes through `qa/lab/lab.sh` (run without args for help). Artifacts land in `qa/runs/` (git-ignored).

## Topology
```
 Server (ts-node, :3000) ◄── socket.io ──┬── bots (node qa/lab/bots.mjs, headless players)
 Metro  (:8081, EXPO_PUBLIC_SERVER_URL)  ├── ios-a  iPhone 17          (simctl, localhost)
                                         ├── ios-b  iPhone 16e
                                         ├── android-a exposeme_a (Pixel 7, API 35)  adb reverse :3000 :8081
                                         └── android-b exposeme_b (Pixel 4, API 35)
```
Devices reach the host through `localhost` (iOS simulators share the host network; Android uses `adb reverse`). The app is a **dev client**: JS comes from Metro, so code changes need no rebuild — only native dependency/config changes need `build`.

## First time (≈20-30 min, mostly builds)
```bash
qa/lab/lab.sh setup        # Maestro CLI, AVDs exposeme_a/b, npm deps
qa/lab/lab.sh up           # 2 iOS + 2 Android (flags: --ios N --android N)
qa/lab/lab.sh server && qa/lab/lab.sh metro
qa/lab/lab.sh build all    # dev-client binaries, installs on every device
qa/lab/lab.sh photos 12    # 12 labelled photos per device gallery + bot photos
```

## Every session
```bash
qa/lab/lab.sh up && qa/lab/lab.sh server && qa/lab/lab.sh metro
qa/lab/lab.sh open                                   # app on all devices → local Metro
RUN_ID=it3-EXP-006 qa/lab/lab.sh play --devices pair --bots 3 --rounds 3   # per-fix check: 1 iOS + 1 Android
RUN_ID=it9-regression qa/lab/lab.sh play --devices all --bots 3 --rounds 10 # regression: all 4 devices
qa/lab/lab.sh shot after-fix                         # screenshot every device
qa/lab/lab.sh down                                   # when finished
```
`play` = bots create the room and wait for `bots + devices` players → each device runs `qa/maestro/play-game.yaml` in parallel (open → join with the code → play, tapping `bot1` as its guess and screenshotting every loop) → host bot starts → results in `qa/runs/<RUN_ID>/` (`bots.json`, `bots.log`, `maestro/<device>/…`, junit xml).

## Why the photos are labelled
`make-photos.swift` stamps `IOS-A · #3`, `ANDROID-B · #7`, `BOT · #2` on each picture. In a screenshot you can see whose gallery the photo came from and check it against the revealed owner — a direct test of the "who's photo" logic and of cross-device sync.

## Parallel fixers (git worktrees)
Each worktree runs its own server for bots: `qa/lab/worktree-setup.sh <worktree>` once, then from the worktree root `qa/lab/lab.sh server --port 3101` … `--stop --port 3101`. The devices, Metro (:8081) and the main server (:3000) belong to the main checkout and are used only after changes are merged into `qa/loop`.

## Bots alone (fast, no devices)
```bash
node qa/lab/bots.mjs --bots 4 --host --rounds 10 --photos qa/runs/photos/bots --out qa/runs/x/bots.json
node qa/lab/bots.mjs --bots 5 --host --chaos 0.15 --upload-fail 0.15     # reconnects + skipped uploads
node qa/lab/bots.mjs --rooms 20 --bots 4 --host                            # load: 20 parallel games
node qa/lab/bots.mjs --bots 3 --code 123456                                # join a room a device created
```
Summary fields: `pass`, `skew_ms` (spread between players receiving the same phase event), `answer_phase_overrun_ms` (server timer accuracy), `upload_ms`, `rounds_skipped`, `consistency_errors` (different payloads per player, owner ≠ revealed answer, round gaps).

## Raw device control (when Maestro is not enough)
- iOS: `xcrun simctl io <udid> screenshot f.png`, `xcrun simctl openurl <udid> <url>`, `xcrun simctl addmedia <udid> *.jpg`, `xcrun simctl privacy <udid> grant photos com.socketNull.ExposeMe`, logs `xcrun simctl spawn <udid> log stream --predicate 'process == "ExposeMe"'`.
- Android: `adb -s <serial> exec-out screencap -p > f.png`, `adb -s <serial> shell input tap X Y`, `adb -s <serial> logcat -s ReactNativeJS`.
- Maestro on one device: `~/.maestro/bin/maestro --device <id> test qa/maestro/<flow>.yaml -e USERNAME=x -e GAME_CODE=123456 -e METRO_URL=http%3A%2F%2Flocalhost%3A8081`. Interactive selector help: `maestro studio`.
- Device ids/labels: `qa/runs/.lab/devices.json`.

## Troubleshooting
- App shows "Could not connect to development server": `lab.sh metro --restart`, then `lab.sh open`; on Android re-run `adb reverse` (`lab.sh up` does it).
- Gallery empty in app: re-run `lab.sh photos`; on Android check `adb shell ls /sdcard/Pictures/ExposeMeQA` and the media scan.
- Permission screen loops: iOS `simctl privacy … grant photos`, Android `pm grant … READ_MEDIA_IMAGES` (done by `up`/`install`).
- Maestro can't find an element: flows select by testID (`Client/app/utils/testIds.ts`, `id:` selectors); check the id in `maestro studio`.
- iOS simulators run headless (no Simulator.app window in Xcode 27 unless the Simulator component is installed); use `lab.sh shot` to see them.
- Machine is slow: `up --ios 1 --android 1` and use more bots.
