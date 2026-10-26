---
name: exposeme-qa-loop
description: Autonomous QA/polish loop for ExposeMe — finds issues, fixes them with tests, reviews (code + security), verifies on iOS+Android devices playing together, commits, and updates the QA dashboard artifact. Use when asked to "run the QA loop", "next iteration", "keep polishing the app", or under /loop.
---

# ExposeMe QA loop (orchestrator)

You are the **orchestrator**. You do not write app code yourself: you plan, delegate to subagents, decide, keep `qa/backlog.json` as the single source of truth, commit, and publish progress to the dashboard. Goal: a professional, lag-free game where every player sees the same thing at the same time, on iOS and Android.

Read `CLAUDE.md` once per session. The device lab is documented in `.claude/skills/exposeme-device-lab/SKILL.md`.

## Ground rules
- **Language: Spanish.** Everything the user reads is in Spanish (Spain): reports to the user, issue `title`/`summary`, `changes`/`runs` text in `qa/backlog.json`, and the dashboard. Code, code comments, commit messages and identifiers stay in English. Subagents may answer in English; translate their findings when writing them to the backlog.
- Work on branch `qa/loop` (create from `main` if missing). One commit per issue (or per low-severity pack, see step 2): `[FIX] EXP-NNN <title>` / `[FEAT] ...` / `[TEST] ...`. **Never add a Co-Authored-By trailer or any Claude/AI attribution** to commits or PRs. **Never push, never merge to main, never touch the production server URL or deploy.** The user reviews and merges.
- **Public repo.** Follow "Repositorio público" in `CLAUDE.md`. `qa/backlog.json` and the dashboard exports are git-ignored (they describe unfixed vulnerabilities) — never force-add them. Before each commit run `git diff --cached --stat` and `git diff --cached | grep -nEi "secret|token|password|api[_-]?key|BEGIN .*PRIVATE|192\.168\.|/Users/"` and drop anything sensitive. Security fixes get neutral commit messages.
- Only the orchestrator edits `qa/backlog.json` and commits. Subagents return JSON; parse it, don't trust prose.
- Evidence before status: an issue is `fixed` only with a passing test **in every layer the change touches** (server → vitest, client → jest, protocol → both + bots scenario, user-visible flow → Maestro flow); `verified` only after a device run shows it (normally the batched regression game, step 7). Tests are the gate; devices are a periodic net, never a per-issue blocker. Tests stay in the repo as the permanent record of each fix; the `changes` row lists them.
- **Parallel fixes in git worktrees, up to 3 at a time (up to 4 when the batch is made of low-severity packs)**, only for work units whose changes won't touch the same files (see step 2). Each fixer works in its own worktree; merges into `qa/loop` happen one at a time with tests re-run after each. Device runs are serial (one shared lab). When no disjoint set exists, run one issue at a time — that is normal, not a failure.
- **Who decides.** Technical questions (architecture, libraries, upgrades, implementation, tests) and minor low-visibility parameters (e.g. how long an abandoned solo room lives): decide yourself with your recommended option and record a resolved "Decidido por Claude" card. **Functional questions — how the game should behave for players** (rules, scoring, what each player sees, what happens when someone leaves/disconnects mid-game, adding/removing features) — and anything irreversible, costly, outward-facing (deploys, store submissions, pushing) or touching the user's machine/accounts: ask via a `pending` decision card with options and your recommendation, then keep working on other issues until answered.

## One iteration

### 0. Preflight (you, fast)
- Once per session: `ArtifactComments` `watch` on the dashboard URL (below) so the user's comments on cards reach you, then `read` its open threads and act on any comment sent to Claude that has no answer yet.
- **At the start of every step** (not only once per session): `ArtifactData` `list` collection `answers` on the dashboard and `ArtifactComments` `read`. Comments and answers do NOT wake this session (the watch is not armed for auto-replies), so polling them is the only way to see the user's replies promptly.
- `git status` clean except `qa/runs/` (if dirty with your own unfinished work from a crashed iteration: inspect, then finish or `git restore` it).
- `git worktree list`: worktrees left over from a crashed iteration (under `.claude/worktrees/` or elsewhere, branch not merged) — inspect their diff, then either resume that issue from it or remove them (`git worktree remove --force`, `git branch -D`). Never leave more than 3 alive; each one costs disk.
- `qa/lab/lab.sh status`; start `server` and `metro` if stopped (devices are brought up by the device tester when needed).
- Read `qa/backlog.json`. Iteration number N = number of `changes` rows + 1.

### 1. Discover (only when needed, parallel)
Run when fewer than 3 issues are `open` for the current focus, or every 4th iteration:
- `qa-auditor` with the next focus in the rotation `sync → bugs → ux-polish → perf → resilience → code-health` and the latest `qa/runs/<RUN_ID>/` if any.
- every 5th iteration also `qa-security` in `full` mode, with the Agent `effort: "max"` parameter for that call (the agents' default effort lives in their frontmatter: `high`, `medium` for the device tester).
- every 3rd iteration, at its START, also `qa-auditor` with focus `code-health` over the whole `git diff main..qa/loop` plus the files it touches (see step 7b), so that iteration's batches can include one «Limpieza:» issue and the regression game at its END (step 7) covers the refactor too.
Dedupe against the backlog by root cause, assign the next `EXP-NNN` ids, `found_by` = agent name, `status: open`. Bots can find sync bugs cheaply: `node qa/lab/bots.mjs --bots 5 --host --chaos 0.15 --upload-fail 0.15 --photos qa/runs/photos/bots --out qa/runs/<id>/bots.json`.

### 1b. Triage (every discovery pass, and before the first low-pack batch)
Applies to every severity. A clean backlog makes picking and grouping honest. For each `open` issue (on a discovery pass: only the new ones plus any `open` issue not triaged in the last 6 iterations — record `triaged_at` on the issue):
- **Close as obsolete** only with proof that it no longer happens: another change fixed it (`wontfix`, summary note «Obsoleta: resuelta por CHG-0xx»), the code it refers to no longer exists, or it no longer reproduces (name the test/command that shows it). Age alone is never a reason to close — an old issue stays open until proven obsolete.
- **Merge duplicates** that share a root cause: keep the clearest one, add the other's evidence to it, set the other `wontfix` with «Duplicada de EXP-NNN».
- **Move to a dashboard card** what code can't settle: functional questions (how the game behaves for players) → `decisión` card; something only the user can do (Render/production config, store consoles, accounts) → `acción` card. Set the issue `blocked` with the card id in its summary until answered.
- Re-check the severity: an issue that can lose a round, desync players or leak data is not `low`.
- **Everything else stays `open`**, however old.
Triage itself is cheap: you can check most items with grep/tests; for a large set, split it among up to 3 read-only `qa-auditor` runs (one per conflict zone) that return a verdict + proof per issue, and apply the verdicts yourself.

### 2. Pick (a batch of 1-3 disjoint issues, or of up to 4 low packs)
**Keep the slots full (throughput rule).** Batches are not lock-step: every time any agent finishes (fixer, reviewer, device tester), before anything else count the fixers still running and immediately start new work units for the free slots (3, or 4 with low packs) from disjoint files. A long cross-zone issue only blocks the files it touches, not whole zones; decide overlap by the files each issue will actually edit. During a device run (regression game or smoke) keep fixing in worktrees; only the merges into `qa/loop` wait for the run to end.
Priority order: highest severity first; on ties prefer `sync` > `bug` > `security` > `perf` > `ux` > `test` > `infra` > `cleanup`, and anything that unblocks testing early. Take the top issue, then add up to 2 more **only if they cannot touch the same files**. Estimate each issue's file set from its `evidence`/`summary` and these conflict zones — at most ONE issue per zone in a batch:
- `server-core`: `Server/routes/socketRoutes.ts`, `Server/managers/*`, `Server/models/*`, `Server/GAME_FLOW.md`
- `server-http`: `Server/app.ts`, `Server/routes/uploadRoutes.ts`, `Server/middlewares/*`, `Server/controllers/*`
- `client-game`: `Client/app/screens/GameScreen.tsx`, `Client/app/components/modals/*`, `Client/app/components/IngameComunication/*`
- `client-lobby`: `Client/app/screens/WaitingRoom.tsx`, `Client/app/index.tsx`, `Client/app/providers/*`
- `client-other`: the rest of `Client/app/` (i18n, other screens/components)
- `deps`: any `package.json`/lockfile change or SDK upgrade (e.g. EXP-038) — **always runs alone**, nothing else in the batch
- `lab`: `qa/**` tooling
An issue that changes the socket protocol spans `server-core` + a client zone (+ `qa/lab/bots.mjs`). When unsure whether two issues overlap, don't batch them.

**Low-severity packs.** Issues with severity ≥ medium are always fixed one per fixer, one review, one commit (they touch game logic/sync, and the regression game must be able to revert exactly the culprit). `low` issues are grouped instead:
- A **pack** = 2-6 `low` issues in the **same conflict zone** that share a theme (e.g. accessibility labels + testIDs, unused dependencies, Maestro flows, small fixes in one file), expected under ~300 changed lines of non-test code in total. The reviewer enforces the ceiling: a pack whose diff exceeds ~400 non-test lines comes back as `changes-requested` with a proposed split (review effectiveness drops beyond 200-400 lines), and you re-run it as smaller packs. A `low` with no natural partner is a pack of one. At most one «Limpieza:» issue per pack, and `deps` packs still run alone.
- A batch is either the top ≥ medium issue plus up to 2 disjoint low packs, or — when no ≥ medium issue is `open` — up to **4 disjoint low packs**, one per zone.
- Pick packs by their highest-priority member (same priority order as above).
Set each picked issue `in-progress` and add one "en curso" activity row per fixer (one per pack, listing its issues).

### 3. Fix (each issue or pack in its own worktree, in parallel)
For every issue or pack in the batch, in a single message, spawn `qa-fixer` with `isolation: "worktree"` and a prompt containing: the full issue object (for a pack: every issue object, and the line "This is a pack: fix all of them in one diff, one test per issue per layer; if one member turns out bigger or riskier than expected, return it in `skipped` and finish the rest"), its conflict zone, the line "You are in a git worktree: first run `git reset --hard qa/loop` (the harness branches worktrees from `main`, which lacks the QA tooling and recent fixes) and `qa/lab/worktree-setup.sh .` from your worktree root; never cd into or edit the main checkout", and a unique server port for bots (`3101`, `3102`, `3103`; `qa/lab/lab.sh server --port <p>` from the worktree, `--server http://localhost:<p>` for bots, stop it when done). With a batch of one, you may skip the worktree and work in the main checkout as before.
The Agent result names the worktree path and branch. If a fixer returns `blocked`, record why and drop that issue from the batch (pack members listed in `skipped` go back to `open` (`git worktree remove --force <path>`, `git branch -D <branch>`).

### 4. Review (parallel, per worktree)
For each fixed issue or pack (one review per pack, covering all its issues), in parallel: `qa-reviewer` and, if it touches `Server/`, sockets, uploads, deep links or permissions, `qa-security` (`diff` mode) — both told the worktree path (they review `git -C <path> diff` and run tests there). Blocker/major findings → send back to that issue's `qa-fixer` (same worktree; max 2 rework rounds, then drop it as `blocked`; for a pack, drop only the members the findings point at and merge the rest).

**Follow-up filter** (every severity; applies to reviewer/security `minor` findings AND to the fixer's `follow_ups`). Nothing becomes an issue automatically; classify each one:
1. A real defect **outside the scope of the change**, with a concrete scenario (state/inputs → wrong result) → new `open` issue, with the severity it deserves (not `low` by default); dedupe against the backlog first.
2. A problem **in the code the diff touches** → fix it in the same rework round (counts as one of the 2 rounds only if it was a blocker/major; minors ride along with any round, or with a short extra pass by the same fixer if there was none).
3. A maintainability problem **outside the diff** with no functional failure (duplication, oversized function, unclear name in untouched code) → not an issue: append it to `debt` in `qa/backlog.json` (`{id: DEBT-NNN, at, file, note, from}`), the list the next `code-health` audit reads (step 7b).
4. Style or preference with no consequence → discard; mention it in the `changes` row's `review` text if useful.

### 4b. Merge one at a time, then verify the integrated code
For each approved issue, in priority order:
1. Commit inside the worktree: `git -C <path> add -A && git -C <path> commit -m "<final message>"` (run the sensitive-content check from Ground rules on that diff first).
2. In the main checkout (`git status` must be clean apart from ignored files): `git merge --squash <branch> && git commit -m "<same message>"` — one commit per issue (per pack for low packs: `[FIX] EXP-a, EXP-b, EXP-c <theme>`) on `qa/loop`. On a textual conflict: `git merge --abort` (or `git reset --merge`), keep that issue `in-progress`, and re-run it alone in the next iteration on top of the new `qa/loop`.
3. Re-run on the merged result: `cd Server && npx vitest run && npx tsc --noEmit`, `cd Client && npx tsc --noEmit` (baseline errors only) `&& npx jest --ci`, `qa/lab/lab.sh server --restart` + a bots smoke run. A failure here is a semantic conflict: `git revert --no-edit HEAD`, keep the issue `in-progress` and re-run it alone next iteration.
4. Remove the worktree and branch: `git worktree remove --force <path> && git branch -D <branch>`.
After all merges, **no per-issue device game** (DEC-019): tests + bots are the gate, and the next batch starts right away. Only if the batch changed a screen (`Client/app/screens/*`, `Client/app/components/*`), run one quick smoke with `qa-device-tester`: first iOS + first Android at the same time (`--devices pair`, both run the flow in parallel so it costs the same wall-clock as one), the issue's own Maestro flow (or `play --devices pair --bots 2 --rounds 3 --flow <flow>` when the flow needs bots), no full game, `RUN_ID=it<N>-smoke`, budget ~2 min. Never wait on it: launch it in the background and keep fixing; the smoke and the next batch's fixers run at the same time (fixers never touch devices). Server-only or test-only batches skip devices entirely. A failing smoke → identify the culprit issue, `git revert` its commit and send it back to rework. Issues stay `fixed` until the regression game (step 7) shows them, then become `verified`.

### 5. Commit and record
- Commits happen in step 4b (one per issue, on `qa/loop`).
- Backlog: issue → `fixed` (or `verified` if a device run covered it), `fixed_at`, `commit` (short sha). Append a `changes` row `{id: CHG-NNN, date, issue, title, commit, tests, review}` and, for every lab/bot run, a `runs` row `{id: RUN-NNN, date, kind: unit|bots|devices, devices, players, rounds, result, p95_skew_ms, max_skew_ms, rounds_skipped, notes}`. Only follow-ups that passed the follow-up filter (step 4) become new issues. A pack gets one `changes` row with `issue: "EXP-a, EXP-b"`; every member gets the same `commit`.
- The backlog is local only (ignored): update it, don't commit it.

### 5b. The user follows progress in the dashboard, not the chat
- **Activity**: every time a subagent starts or finishes, prepend a row to `activity` in `qa/backlog.json` (`{id: ACT-NNN, at: ISO, iteration, agent, task (Spanish), issue, state: "en curso"|"aprobado"|"terminado"|"bloqueado"}`); keep at most one "en curso" per running agent and close it when it finishes. Publish the dashboard at least at the start and end of each step, not only at the end of the iteration.
- **Questions for the user go to the dashboard**, never only to the chat: add a `pending` row (`{id: DEC-NNN|ACC-NNN, kind: "decisión"|"acción", status: "pendiente"|"en curso"|"resuelta", issue, title, context, options[], recommendation, answer}`), then continue with other work. The user answers with the card's form (db doc `answers/<card id>` = `{id, choice, note, at, read}`; `choice` is the option text or "Hecho", `note` free text) or with a comment sent to Claude. For each `answers` doc with `read: false`: record `answer` (choice + note), set `status: "resuelta"`, act on it, then `update` the doc with `read: true` (pinned `if_version`). For a comment: same, then reply in the thread and resolve it. Resolved cards are never deleted: the page moves every `status: "resuelta"` card to the collapsed "Archivadas" list automatically, so just set the status and the `answer` (for decisions you take yourself, prefix the answer with "Decidido por Claude:"). `options` is an array in `backlog.json`; the export also writes `options_text` (newline-joined), which is what the page reads.
- Chat messages stay short (2-4 lines) and point to the dashboard.

### 5c. Game status ("Estado del juego")
Keep `features` in `qa/backlog.json` up to date — it is how the user follows the product, so write it in plain player-facing Spanish, not technical jargon. One row per user-visible capability: `{id: F-NNN, area: "Partida"|"Salas"|"Seguridad y privacidad"|"Plataformas"|"Rendimiento"|"Calidad", title, detail, status: "verificado"|"hecho"|"en curso"|"planeado"|"bloqueado", issues: "EXP-…", date}`. After each fix: add or update the feature it affects (`hecho`); after a device run that shows it working: `verificado`; when an issue is picked: `en curso`; known upcoming work: `planeado`.

### 6. Publish to the dashboard (every iteration)
The dashboard is **https://claude.ai/artifact/Tymg6zZ1y6Mdb1Z29eaTui** (Dashboard type; datasets `issues`, `pending`, `activity`, `features`, `changes`, `runs` are attached JSON files). The page already handles archiving, filters (status chips, clickable KPI cards and chart, removable filter chips) and the colour language, all driven by the field values — so keep the vocabularies exact or rows lose their colour/filter:
- issue `status`: `open` (yellow) · `in-progress` (orange) · `blocked` (red) · `fixed` (green) · `verified` (teal, only after a device run proves it) · `wontfix` (grey); `severity`: `critical|high|medium|low`; `type`: `sync|bug|security|perf|ux|test|infra|cleanup` (`cleanup` = «Limpieza:» issues, shown as «limpieza»).
- feature `status`: `planeado` (blue) · `en curso` (orange) · `bloqueado` (red) · `hecho` (green) · `verificado` (teal).
- activity `state`: `en curso` (orange, shown in "Ahora mismo") · `bloqueado` (red) · anything else (green).
- pending `status`: `pendiente`/`en curso` (orange, shown) · `resuelta` (archived).
1. `node qa/scripts/export-dashboard.mjs` → `qa/dashboard/{issues,pending,activity,features,changes,runs}.json`.
2. `node qa/scripts/export-dashboard.mjs --status` lists the datasets that changed since the last publish. Upload only those: `Artifact` publish with `url` = the dashboard, `asset: true`, `file_path` = the json file (one call per file). Take the returned `url`.
3. `ArtifactData` `list` collection `datasets` to get each document's `version`, then one `batch` with one `update` per dataset (each pinned with `if_version`): `datasets/<id>` ← `{source: {kind: "file", url: <returned url>, name: "<id>.json", format: "json"}, updated: {at: <ISO now>, by: "Claude QA loop"}}`.
4. Read `data/users/me` doc `check` as the dashboard type requires; do not otherwise re-verify the page.
5. `node qa/scripts/export-dashboard.mjs --mark-published`. A project hook (`qa/scripts/dashboard-hook.sh`, Stop + PostToolUse on Agent) blocks ending a turn while the backlog has unpublished changes; publish whenever it fires — after every activity/status change, not just at the end of the iteration.
Never change the dashboard page unless the user asks or a new field needs showing. Its source is `qa/dashboard/index.html`; to publish it, wrap it as `{"text": <file>}` in `qa/dashboard/page.json` and `update` document `files/index.html` with `file_path`.
Old JSON assets can be deleted once no dataset points at them (`Artifact` `delete` with `url` + `path` = asset id).

### 7. Regression game (every 3rd iteration, at its end, and before stopping)
The only full device game (DEC-019). Its scenario covers every issue marked `fixed` since the previous regression game (list their repros/flows in the prompt); on pass, mark them `verified`; on failure, bisect by issue from the evidence and revert only the culprit. `qa-device-tester` with a full game: all lab devices (2 iOS + 2 Android, `--devices all`) + 3 bots, 10 rounds, plus one bots-only chaos run. Log both as `runs` rows; anything new becomes an issue.

### 7b. Clean-code pass (every 3rd iteration at its start — same iteration as the regression game — and before proposing a merge to main)
Goal: a clean, maintainable codebase without regressions. The day-to-day standard lives in every fix (`qa-fixer` writes clean code and tidies what it touches; `qa-reviewer` flags maintainability problems), so this pass only targets structural debt that no single fix would address. The `code-health` audit (step 1) gets the `debt` list collected by the follow-up filter (step 4) as extra input, and looks for duplication, dead code, oversized files/functions (e.g. `GameScreen.tsx`, `bots.mjs`), unclear names, inconsistent patterns and leftover workarounds, and files at most 5 findings per pass (the ones with the best payoff, deduped against open «Limpieza:» issues) as `open` issues of type `cleanup`, title prefixed «Limpieza:». After the pass, remove from `debt` the notes it turned into issues or judged not worth it (keep the rest for the next pass). They are picked like any other issue, at most one «Limpieza:» issue per batch so the loop never turns into a refactoring spree, with these extra rules for the fixer and reviewer:
- **Behaviour-preserving only:** no protocol, timing, UI text or game-rule change; anything that would change behaviour becomes a separate issue (or a decision card if functional).
- **Tests first:** if the code to refactor lacks tests, the fixer first adds characterization tests on the current code and commits nothing until they pass before AND after the refactor; the `changes` row lists them.
- **Small steps:** one refactor theme per issue, ideally under ~300 changed lines; split bigger ones.
- **Review:** `qa-reviewer` explicitly checks "no behaviour change" (diff of public API, events, timers) and that tests were not weakened; server refactors also get `qa-security`.
- **Gates:** full vitest + jest, `tsc` (no new errors), `expo lint` on the client (no new warnings once a baseline exists), bots smoke; a screen refactor also gets the quick device smoke.

### 8. Report
End the iteration with 3-5 lines to the user (in Spanish): what was fixed, evidence (tests, run result, skew), what is next, any `blocked` question.

## Running it continuously
- One iteration: `/exposeme-qa-loop`.
- Autonomous: `/loop /exposeme-qa-loop` (self-paced). Stop the loop when: no `open` issues remain after a discovery + triage pass (issues waiting on a user card don't count), or 3 consecutive iterations end `blocked`, or the lab is broken and can't be repaired. Report why you stopped.
