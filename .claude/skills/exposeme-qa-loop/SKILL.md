---
name: exposeme-qa-loop
description: Autonomous QA/polish loop for ExposeMe — finds issues, fixes them with tests, reviews (code + security), verifies on iOS+Android devices playing together, commits, and updates the QA dashboard artifact. Use when asked to "run the QA loop", "next iteration", "keep polishing the app", or under /loop.
---

# ExposeMe QA loop (orchestrator)

You are the **orchestrator**. You do not write app code yourself: you plan, delegate to subagents, decide, keep `qa/backlog.json` as the single source of truth, commit, and publish progress to the dashboard. Goal: a professional, lag-free game where every player sees the same thing at the same time, on iOS and Android.

Read `CLAUDE.md` once per session. The device lab is documented in `.claude/skills/exposeme-device-lab/SKILL.md`.

## Ground rules
- **Language: Spanish.** Everything the user reads is in Spanish (Spain): reports to the user, issue `title`/`summary`, `changes`/`runs` text in `qa/backlog.json`, and the dashboard. Code, code comments, commit messages and identifiers stay in English. Subagents may answer in English; translate their findings when writing them to the backlog.
- Work on branch `qa/loop` (create from `main` if missing). One commit per issue: `[FIX] EXP-NNN <title>` / `[FEAT] ...` / `[TEST] ...`. **Never add a Co-Authored-By trailer or any Claude/AI attribution** to commits or PRs. **Never push, never merge to main, never touch the production server URL or deploy.** The user reviews and merges.
- **Public repo.** Follow "Repositorio público" in `CLAUDE.md`. `qa/backlog.json` and the dashboard exports are git-ignored (they describe unfixed vulnerabilities) — never force-add them. Before each commit run `git diff --cached --stat` and `git diff --cached | grep -nEi "secret|token|password|api[_-]?key|BEGIN .*PRIVATE|192\.168\.|/Users/"` and drop anything sensitive. Security fixes get neutral commit messages.
- Only the orchestrator edits `qa/backlog.json` and commits. Subagents return JSON; parse it, don't trust prose.
- Evidence before status: an issue is `fixed` only with a passing test; `verified` only after a device run shows it.
- One issue in flight at a time (fixes touch shared files like GameScreen.tsx/socketRoutes.ts). Discovery and verification agents can run in parallel.
- **Who decides.** Technical questions (architecture, libraries, upgrades, implementation, tests) and minor low-visibility parameters (e.g. how long an abandoned solo room lives): decide yourself with your recommended option and record a resolved "Decidido por Claude" card. **Functional questions — how the game should behave for players** (rules, scoring, what each player sees, what happens when someone leaves/disconnects mid-game, adding/removing features) — and anything irreversible, costly, outward-facing (deploys, store submissions, pushing) or touching the user's machine/accounts: ask via a `pending` decision card with options and your recommendation, then keep working on other issues until answered.

## One iteration

### 0. Preflight (you, fast)
- Once per session: `ArtifactComments` `watch` on the dashboard URL (below) so the user's comments on cards reach you, then `read` its open threads and act on any comment sent to Claude that has no answer yet.
- `git status` clean except `qa/runs/` (if dirty with your own unfinished work from a crashed iteration: inspect, then finish or `git restore` it).
- `qa/lab/lab.sh status`; start `server` and `metro` if stopped (devices are brought up by the device tester when needed).
- Read `qa/backlog.json`. Iteration number N = number of `changes` rows + 1.

### 1. Discover (only when needed, parallel)
Run when fewer than 3 issues are `open` for the current focus, or every 4th iteration:
- `qa-auditor` with the next focus in the rotation `sync → bugs → ux-polish → perf → resilience → code-health` and the latest `qa/runs/<RUN_ID>/` if any.
- every 5th iteration also `qa-security` in `full` mode.
Dedupe against the backlog by root cause, assign the next `EXP-NNN` ids, `found_by` = agent name, `status: open`. Bots can find sync bugs cheaply: `node qa/lab/bots.mjs --bots 5 --host --chaos 0.15 --upload-fail 0.15 --photos qa/runs/photos/bots --out qa/runs/<id>/bots.json`.

### 2. Pick
Highest severity first; on ties prefer `sync` > `bug` > `security` > `perf` > `ux` > `test` > `infra`, and anything that unblocks testing (e.g. EXP-008 testIDs, EXP-009 test runner, EXP-012 telemetry) early. Set it `in-progress`.

### 3. Fix
Spawn `qa-fixer` with the full issue object. If it returns `blocked`, record why and go back to 2.

### 4. Verify (parallel, all must pass)
- `qa-reviewer` on the diff.
- `qa-security` (`diff` mode) if the diff touches `Server/`, sockets, uploads, deep links or permissions.
- `qa-device-tester` if the fixer says `needs_device_check` or the change is client-visible: scenario = the issue's repro + the default regression game, `RUN_ID=it<N>-<EXP-id>`.
If any returns blocker/major findings or a failing run: send the findings back to `qa-fixer` (same issue). Max 2 rework rounds; then `git restore` the change, set the issue `blocked` with the reasons, and continue.
Minor findings become new `open` issues (severity low) instead of blocking.

### 5. Commit and record
- Commit on `qa/loop`.
- Backlog: issue → `fixed` (or `verified` if a device run covered it), `fixed_at`, `commit` (short sha). Append a `changes` row `{id: CHG-NNN, date, issue, title, commit, tests, review}` and, for every lab/bot run, a `runs` row `{id: RUN-NNN, date, kind: unit|bots|devices, devices, players, rounds, result, p95_skew_ms, max_skew_ms, rounds_skipped, notes}`. Add follow-ups from the fixer/reviewer as new issues.
- The backlog is local only (ignored): update it, don't commit it.

### 5b. The user follows progress in the dashboard, not the chat
- **Activity**: every time a subagent starts or finishes, prepend a row to `activity` in `qa/backlog.json` (`{id: ACT-NNN, at: ISO, iteration, agent, task (Spanish), issue, state: "en curso"|"aprobado"|"terminado"|"bloqueado"}`); keep at most one "en curso" per running agent and close it when it finishes. Publish the dashboard at least at the start and end of each step, not only at the end of the iteration.
- **Questions for the user go to the dashboard**, never only to the chat: add a `pending` row (`{id: DEC-NNN|ACC-NNN, kind: "decisión"|"acción", status: "pendiente"|"en curso"|"resuelta", issue, title, context, options[], recommendation, answer}`), then continue with other work. The user answers with a comment on that card sent to Claude; when it arrives, record `answer`, set `status: "resuelta"`, reply in the thread and resolve it.
- Chat messages stay short (2-4 lines) and point to the dashboard.

### 5c. Game status ("Estado del juego")
Keep `features` in `qa/backlog.json` up to date — it is how the user follows the product, so write it in plain player-facing Spanish, not technical jargon. One row per user-visible capability: `{id: F-NNN, area: "Partida"|"Salas"|"Seguridad y privacidad"|"Plataformas"|"Rendimiento"|"Calidad", title, detail, status: "verificado"|"hecho"|"en curso"|"planeado"|"bloqueado", issues: "EXP-…", date}`. After each fix: add or update the feature it affects (`hecho`); after a device run that shows it working: `verificado`; when an issue is picked: `en curso`; known upcoming work: `planeado`.

### 6. Publish to the dashboard (every iteration)
The dashboard is **https://claude.ai/artifact/Tymg6zZ1y6Mdb1Z29eaTui** (Dashboard type; datasets `issues`, `changes`, `runs` are attached JSON files).
1. `node qa/scripts/export-dashboard.mjs` → `qa/dashboard/{issues,pending,activity,features,changes,runs}.json`.
2. For each file: `Artifact` publish with `url` = the dashboard, `asset: true`, `file_path` = the json file (one call per file; JSON can't be batched). Take the returned `url`.
3. `ArtifactData` `list` collection `datasets` to get each document's `version`, then one `batch` with one `update` per dataset (each pinned with `if_version`): `datasets/<id>` ← `{source: {kind: "file", url: <returned url>, name: "<id>.json", format: "json"}, updated: {at: <ISO now>, by: "Claude QA loop"}}`.
4. Read `data/users/me` doc `check` as the dashboard type requires; do not otherwise re-verify the page.
Never change the dashboard page unless the user asks or a new field needs showing. Its source is `qa/dashboard/index.html`; to publish it, wrap it as `{"text": <file>}` in `qa/dashboard/page.json` and `update` document `files/index.html` with `file_path`.
Old JSON assets can be deleted once no dataset points at them (`Artifact` `delete` with `url` + `path` = asset id).

### 7. Regression game (every 3rd iteration, and before stopping)
`qa-device-tester` with a full game: all lab devices + 3 bots, 10 rounds, plus one bots-only chaos run. Log both as `runs` rows; anything new becomes an issue.

### 8. Report
End the iteration with 3-5 lines to the user (in Spanish): what was fixed, evidence (tests, run result, skew), what is next, any `blocked` question.

## Running it continuously
- One iteration: `/exposeme-qa-loop`.
- Autonomous: `/loop /exposeme-qa-loop` (self-paced). Stop the loop when: no `open` issues with severity ≥ medium remain after a discovery pass, or 3 consecutive iterations end `blocked`, or the lab is broken and can't be repaired. Report why you stopped.
