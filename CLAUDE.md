# ExposeMe

Multiplayer party game: each round shows a random photo from one player's gallery and everyone else guesses whose it is. Store-ready (Android `com.socketNull.ExposeMe`, iOS same bundle id).

## Layout
- `Client/` — Expo SDK 52, React Native 0.76 (new arch), expo-router v4, twrnc styling, socket.io-client. Screens in `app/screens/`, global state in `app/providers/` (GameContext = socket + room, PhotoContext = gallery access), i18n en/es in `app/i18n/`. Native folders `ios/` and `android/` are generated locally by prebuild and are NOT tracked (ignored in `Client/.gitignore`).
- `Server/` — Express + socket.io, run with ts-node. `managers/GameEngine.ts` owns all game timing (server is the single source of truth, see `Server/GAME_FLOW.md`), `managers/RoomManager.ts` rooms/players in memory, `routes/socketRoutes.ts` event handlers, `/upload` stores photos in `Server/temp` for 30 min.
- `qa/` — QA lab: `lab/lab.sh` (devices, server, Metro, games), `lab/bots.mjs` (headless players + sync metrics), `maestro/` (device flows), `backlog.json` (local-only issue tracker, source of truth for the dashboard), `runs/` (git-ignored artifacts).

## Repositorio público (IMPORTANTE)
This repo is PUBLIC on GitHub (RivotX/ExposeMe_mobile-app). Before every commit, check `git diff --cached --stat` and never commit:
- Secrets or credentials: `.env*`, keystores/certs (`*.jks`, `*.p12`, `*.p8`, `*.pem`, `*.keystore`), `google-services.json`, `GoogleService-Info.plist`, EAS/Expo/Render/Apple tokens, API keys. Use env vars; document them in an `.env.example` with placeholder values.
- Personal data: real photos, gallery content, `Server/temp/`, screenshots, device logs, IPs, UDIDs. All QA artifacts live in `qa/runs/` (ignored).
- Vulnerability details: `qa/backlog.json`, `qa/dashboard/*.json`, security-agent reports and exploit snippets stay local (ignored) until the fix ships, and even then never commit exploit code. Security fix commit messages describe the hardening neutrally (e.g. "[FIX] Validate socket payloads against session"), not how to exploit the old code.
- Production config changes (server URL, bundle ids, store/EAS config) without the user's approval.
If something sensitive is ever committed, stop and tell the user (rotation + history rewrite is their call); never force-push on your own.

## Commands
- Server: `cd Server && npm run dev` (port 3000). Type check: `npx tsc --noEmit`.
- Client: `cd Client && EXPO_PUBLIC_SERVER_URL=http://localhost:3000 npx expo start --dev-client`. Type check: `npx tsc --noEmit`. Tests: `npx jest --ci`.
- Lab: `qa/lab/lab.sh` (see `.claude/skills/exposeme-device-lab/SKILL.md`).
- `Client/config.ts` falls back to the production server (Render) when `EXPO_PUBLIC_SERVER_URL` is unset. Never point QA traffic at production.

## Conventions
- Commit messages: `[FIX] …`, `[FEAT] …`, `[TEST] …`, `[CHORE] …`. Never add `Co-Authored-By: Claude` or any AI attribution.
- Code style: functional components + hooks, twrnc `tw\`…\`` classes, comments in English, short section banners (`// ── Name ──`) in long files.
- Any socket protocol change updates server, client, `Server/GAME_FLOW.md` and `qa/lab/bots.mjs` together.
- Client must never run its own game timers; it renders server phases with the `duration` it receives.

## QA loop
The autonomous fix/polish workflow is the `exposeme-qa-loop` skill (`/exposeme-qa-loop`, or `/loop /exposeme-qa-loop`). Subagents: `qa-auditor`, `qa-fixer`, `qa-reviewer`, `qa-security`, `qa-device-tester` in `.claude/agents/`. Work happens on branch `qa/loop`; progress is published to the QA dashboard artifact https://claude.ai/artifact/Tymg6zZ1y6Mdb1Z29eaTui.
