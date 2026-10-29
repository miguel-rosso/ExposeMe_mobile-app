#!/usr/bin/env bash
# qa/lab/bots-analysis.mjs, the checks and metrics of a bots room (no network):
# - characterization (EXP-247): every fixture in fixtures/bots-analysis/ (anonymised events of real runs, plus broken
#   variants and synthetic games so that each check function reports at least one error: dropping any of them from
#   analyseRoom fails this test) must give exactly the summary the original analyse() of bots.mjs gave (`expected`),
#   errors in the same order. lab.sh, bots-cli.test.sh and the dashboard read that JSON. The fixtures were recorded
#   with an 8 s answer timer (300 ms grace); EXP-306 made it 8.5 s (800 ms grace) with the same 7.7 s `duration`, so
#   their answer_phase_overrun_ms reads ~500 ms early (reveals came sooner than today's server sends them).
# - players out of the room (EXP-139): leave (--leave-round) and lobby kick (--kick) checks on small synthetic games, and the
#   photo owner leaving during their round (--leave-owner, EXP-301 / DEC-038): still the answer, voters score.
# - holds of the scoreboard (--hold, EXP-303): everyone let go within 1 s of the holder releasing or going away.
# Run: qa/lab/tests/bots-analysis.test.sh
# A change meant to alter the summary: UPDATE_FIXTURES=1 qa/lab/tests/bots-analysis.test.sh rewrites every fixture's
# `expected` with the current output; review the diff (only the intended fields may change) before committing it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYSIS="$HERE/../bots-analysis.mjs"
FIXTURES="$HERE/fixtures/bots-analysis"
pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
ko() { fail=$((fail + 1)); echo "FAIL - $1${2:+ ($2)}"; }

# ── Characterization: the summary of each recorded room is unchanged ──
for f in "$FIXTURES"/*.json; do
  name="$(basename "$f" .json)"
  out="$(node --input-type=module -e '
    import fs from "node:fs";
    import assert from "node:assert/strict";
    const { analyseRoom } = await import(process.argv[1]);
    const file = process.argv[2];
    const text = fs.readFileSync(file, "utf8");
    const { opts, room, expected } = JSON.parse(text);
    const actual = JSON.parse(JSON.stringify(analyseRoom(room, opts)));
    if (process.env.UPDATE_FIXTURES === "1") {
      // The fixture keeps "expected" last, after one event per line: only that part is rewritten
      const EXPECTED_KEY = "\n\"expected\": ";
      fs.writeFileSync(file, `${text.slice(0, text.indexOf(EXPECTED_KEY))}${EXPECTED_KEY}${JSON.stringify(actual, null, 1)}\n}\n`);
      process.exit(0);
    }
    try {
      assert.deepStrictEqual(actual, expected);
    } catch (e) { console.log(e.message.split("\n").slice(0, 30).join("\n")); process.exit(1); }
  ' "$ANALYSIS" "$f" 2>&1)" && ok "$name: same summary as the original analyse()" || ko "$name: same summary as the original analyse()" "$out"
done

# ── Leave / kick (EXP-139) ──
# A synthetic 3-round game of bot1 (host), bot2, bot3 where one player leaves at round 2, or the host removes one in
# the lobby (a bot, or a device "ios-a" the bots only see the notice of; never mid-game, EXP-316); the
# mutation breaks it. In "owner-left" bot3 leaves while its own photo is round 2's, and bot2 votes for it after it left. Prints the consistency errors, one per line, and who has missed events (a player out of the
# room misses the rest of the game on purpose, so a clean game prints nothing).
exits() { # scenario (left|owner-left|lobby-kick|lobby-kick-device), mutation (none|...)
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const [scenario, mutation] = process.argv.slice(2);
    const players = ["bot1", "bot2", "bot3"];
    const events = [];
    let t = 0;
    const at = (bot, ev, round, payload) => events.push({ bot, ev, round, t: (t += 10), ...(payload !== undefined ? { payload } : {}) });
    const all = (names, ev, round, payload) => names.forEach((n) => at(n, ev, round, typeof payload === "function" ? payload(n) : payload));
    const out = scenario === "lobby-kick-device" ? "ios-a" : "bot3";
    const lobbyKick = scenario.startsWith("lobby-kick");
    const inGame = lobbyKick ? players.filter((n) => n !== out) : players;
    const bots = (names) => names.filter((n) => players.includes(n));
    const leaves = scenario === "left" || scenario === "owner-left";
    const ownerLeftIn = (round) => scenario === "owner-left" && round === 2;
    const points = new Map();
    if (lobbyKick) {
      at("bot1", "kick-sent", 0, { username: out });
      if (mutation !== "no-notice") all(players, "player-removed", 0, { username: out });
      if (out === "bot3" && mutation !== "still-connected") at("bot3", "kicked-out", 0, { reason: "io server disconnect" });
      if (mutation === "events-after-kick") at("bot3", "game-started", 0, { rounds: 3, players: ["bot1", "bot2", "bot3"] });
    }
    all(bots(inGame), "game-started", 0, { rounds: 3, players: mutation === "in-game-started" ? [...inGame, out] : inGame });
    let room = bots(inGame);
    for (let round = 1; round <= 3; round++) {
      if (mutation === "game-stopped" && round === 3) break;
      all(room, "waiting-photo", round, { round, duration: 15000 });
      all(room, "round-start", round, { photo: `/temp/p${round}.jpg`, duration: 7700 });
      if (round === 2 && leaves) {
        at("bot3", "left-room", 2, scenario === "owner-left" ? { owner: true } : undefined);
        room = ["bot1", "bot2"];
        if (mutation !== "no-notice") all(room, "player-left", 2, { username: "bot3" });
      }
      const answer = mutation === "answer-after-exit" && round === 3 ? out
        : ownerLeftIn(round) && mutation !== "owner-not-answer" ? "bot3" : "bot1";
      const votesOwner = ownerLeftIn(round) && mutation !== "nobody-voted-owner";
      const guessOf = (u) => (u === "bot1" ? "" : mutation === "guess-after-exit" && round === 3 ? out : votesOwner ? "bot3" : "bot1");
      all(room, "guess-sent", round, (n) => ({ guess: guessOf(n) }));
      all(room, "round-reveal", round, { correctAnswer: answer });
      const rows = [...room, ...(mutation === "scores-after-exit" && round === 3 ? [out] : [])];
      for (const u of rows) {
        const pointMissing = mutation === "owner-point-missing" && ownerLeftIn(round);
        if (guessOf(u) === answer && !pointMissing) points.set(u, (points.get(u) ?? 0) + 1);
      }
      all(room, "round-scores", round, { round, scores: rows.map((u) => ({ username: u, points: points.get(u) ?? 0, lastGuess: guessOf(u), lastAnswerCorrect: guessOf(u) === answer })) });
    }
    all(room, "game-over", 3, { finalScore: [] });
    // A phase event the leaver really missed while still in the room (before its exit) is still reported
    const missedBeforeExit = (e) => mutation === "missed-before-exit" && e.bot === "bot3" && e.ev === "round-reveal" && e.round === 1;
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events: events.filter((e) => !missedBeforeExit(e)) };
    const summary = analyseRoom(r, { host: true, rounds: 3, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 });
    const missed = Object.keys(summary.missed_events);
    console.log([...summary.consistency_errors, ...(missed.length ? [`missed events: ${missed.map((n) => `${n} [${summary.missed_events[n].join(" ")}]`).join(", ")}`] : [])].join("\n"));
  ' "$ANALYSIS" "$@"
}
expect_clean() { # label, scenario
  local got; got="$(exits "$2" none)"
  [ -z "$got" ] && ok "$1" || ko "$1" "$got"
}
expect_error() { # label, scenario, mutation, expected error text
  local got; got="$(exits "$2" "$3")"
  [[ "$got" == *"$4"* ]] && ok "$1" || ko "$1" "expected [$4] in [$got]"
}
expect_clean "a bot leaving at round 2: the game goes on without it" left
expect_clean "the owner leaving during its round: still the answer, a vote for it after it left scores" owner-left
expect_error "owner leaving: a vote for it scored without its point" owner-left owner-point-missing "round 2: bot2 voted bot3, the owner who left, but was scored correct with 0 point(s)"
expect_error "owner leaving: still guessed in a later round" owner-left guess-after-exit "bot2: guessed bot3 after it left"
expect_error "owner leaving: nobody voted for it (the rule not exercised)" owner-left nobody-voted-owner "round 2: nobody voted bot3, the owner who left"
expect_error "owner leaving: the round's answer is someone else" owner-left owner-not-answer "round 2: bot3 left as its owner but the answer was bot1"
expect_clean "a bot kicked in the lobby: not in the game" lobby-kick
expect_clean "a device kicked in the lobby (bots only see the notice)" lobby-kick-device
expect_error "leave: a stayer never told (player-left)" left no-notice "bot1: never got player-left for bot3"
expect_error "kick: a stayer never told (player-removed)" lobby-kick no-notice "bot2: never got player-removed for bot3"
expect_error "leave: still in a later round-scores" left scores-after-exit "bot1: bot3 left but is still in round-scores"
expect_error "kick: someone guessed the removed player" lobby-kick guess-after-exit "bot2: guessed bot3 after it was removed"
expect_error "leave: the answer of a later round is the leaver" left answer-after-exit "round 3: the answer is bot3, who left in round 2"
expect_error "leave: no round after the leave" left game-stopped "bot1: no round after round 2, when bot3 left"
expect_error "kick: the kicked bot stays connected" lobby-kick still-connected "bot3: still connected after being kicked"
expect_error "lobby kick: the kicked bot is in game-started" lobby-kick in-game-started "bot1: bot3 was removed but is in game-started"
expect_error "lobby kick: the kicked bot gets game-started" lobby-kick events-after-kick "bot3: got game-started after being kicked"
expect_error "leave: an event missed before the exit is still a missed event" left missed-before-exit "missed events: bot3"
got="$(exits left missed-before-exit)"
[[ "$got" == "missed events: bot3 [round-reveal#1]" ]] && ok "leave: only that one is reported (none of the rounds after the exit)" || ko "leave: only that one is reported" "$got"

# ── --drop-on-turn: the photo owner drops while its photo is awaited (EXP-226, EXP-029 / DEC-035) ──
# A synthetic 1-round game of N bots where bot1, the round's owner, is away S seconds. Outcome "kept": it comes back
# and its photo is played; "repicked": AFTER ms after the drop the others get a new waiting-photo of round 1 and bot2's
# photo is played; "skipped": the same, preceded by the room's round-skipped (no reason: only the owner's own copy has
# one, EXP-110); "lost": like "repicked", but the game ends without playing round 1. Prints the consistency errors, one
# per line (a game as the server plays it prints nothing).
owner_drop() { # bots, away secs, outcome (kept|repicked|skipped|lost), new pick after ms
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const [n, secs, outcome, skipAfter] = process.argv.slice(2).map((v, i) => (i === 2 ? v : Number(v)));
    const players = Array.from({ length: n }, (_, i) => `bot${i + 1}`);
    const others = players.slice(1);
    const events = [];
    const at = (bot, ev, round, t, payload) => events.push({ bot, ev, round, t, ...(payload !== undefined ? { payload } : {}) });
    const all = (names, ev, round, t, payload) => names.forEach((b) => at(b, ev, round, t, payload));
    const DROP = 1_000;
    const back = DROP + secs * 1000;
    all(players, "game-started", 0, 0, { rounds: 1, players });
    all(players, "waiting-photo", 1, 500, { round: 1, duration: 15000 });
    at("bot1", "your-turn", 1, 600, { attempt: 1 });
    at("bot1", "planned-disconnect", 1, DROP, { secs, onTurn: true, attempt: 1 });
    let owner = "bot1";
    let attempt = 1;
    const repicked = outcome !== "kept";
    if (repicked) {
      if (outcome === "skipped") all(others, "round-skipped", 1, DROP + skipAfter, { round: 1 });
      all(others, "waiting-photo", 1, DROP + skipAfter + 1, { round: 1, duration: 15000 });
      owner = "bot2";
      attempt = 2;
      at(owner, "your-turn", 1, DROP + skipAfter + 2, { attempt });
    }
    at("bot1", "game-state", 1, back, { phase: "waiting-photo", paused: false, started: true });
    if (outcome === "kept") at("bot1", "your-turn", 1, back + 1, { attempt });
    const start = Math.max(back, DROP + (repicked ? skipAfter : 0)) + 100;
    if (outcome !== "lost") {
      at(owner, "photo-sent", 1, start - 50, { attempt });
      all(players, "round-start", 1, start, { photo: "/temp/p1.jpg", duration: 7700 });
      all(players, "round-reveal", 1, start + 8500, { correctAnswer: owner });
      all(players, "round-scores", 1, start + 11500, { round: 1, scores: players.map((u) => ({ username: u, points: 0, lastGuess: "", lastAnswerCorrect: false })) });
    }
    all(players, "game-over", 1, start + 16500, { finalScore: [] });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    console.log(analyseRoom(r, { host: true, rounds: 1, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 }).consistency_errors.join("\n"));
  ' "$ANALYSIS" "$@"
}
owner_drop_case() { # label, expected error text ("" = none), owner_drop args...
  local label="$1" want="$2" got; shift 2
  got="$(owner_drop "$@")"
  if [ -z "$want" ]; then [ -z "$got" ] && ok "$label" || ko "$label" "$got"
  else [[ "$got" == *"$want"* ]] && ok "$label" || ko "$label" "expected [$want] in [$got]"; fi
}
owner_drop_case "3 bots, owner back within the window: its photo is played" "" 3 1 kept 0
owner_drop_case "3 bots, owner away 6 s: another player is asked for the same round after the window" "" 3 6 repicked 3000
owner_drop_case "3 bots, owner away 6 s but nobody else is asked" "round 1: nobody else was asked for its photo although its owner bot1 was away 6 s" 3 6 kept 0
owner_drop_case "3 bots, owner away 6 s: another owner asked only after the 15 s wait" "round 1: another owner was asked 15001 ms after bot1 dropped" 3 6 repicked 15000
owner_drop_case "3 bots, owner away 6 s: its round is skipped instead" "round 1 skipped when its owner bot1 went away" 3 6 skipped 3000
owner_drop_case "3 bots, owner away 6 s: the game ends without that round" "game over after 0 of 1 rounds" 3 6 lost 3000
owner_drop_case "3 bots, owner back within the window but replaced" "bot1: never sent its round 1 photo (attempt 1) after returning" 3 1 repicked 3000
owner_drop_case "3 bots, owner away about the window: either outcome" "" 3 3 repicked 3000
# EXP-110: the others' copies have no reason; a skip the whole 15 s wait after the waiting-photo is still a timeout
owner_drop_case "3 bots, owner back within the window, then its round times out (copies without a reason)" \
  "round 1 skipped by timeout after its owner bot1 returned" 3 1 skipped 14500
got="$(owner_drop 3 1 skipped 1500)"
[[ "$got" != *"skipped by timeout"* ]] && ok "3 bots, owner back within the window, round skipped at once: not taken for a timeout" \
  || ko "3 bots, owner back within the window, round skipped at once: not taken for a timeout" "$got"

# ── planted_rounds: only the bots' own plants (EXP-163) ──
# A 3-round game of bot1, bot2 and the device ios-a: round 1 is bot1's upload (your-turn), round 2 the device's (its
# your-turn never reaches the bots), round 3 bot2's planted photo (no your-turn). Prints planted_rounds as JSON.
planted_rounds() { # mutation: none | bot2-asked (bot2 planted, but round 3 was a normal turn of bot2) | no-plant
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const mutation = process.argv[2];
    const players = ["bot1", "bot2"];
    const events = [];
    let t = 0;
    const all = (ev, round, payload) => players.forEach((bot) => events.push({ bot, ev, round, t: (t += 10), payload }));
    if (mutation !== "no-plant") events.push({ bot: "bot2", ev: "planted", round: 0, t: (t += 10) });
    all("game-started", 0, { rounds: 3, players: [...players, "ios-a"] });
    const owners = ["bot1", "ios-a", "bot2"];
    owners.forEach((owner, i) => {
      const round = i + 1;
      all("waiting-photo", round, { round, duration: 15000 });
      if (owner === "bot1" || (owner === "bot2" && mutation === "bot2-asked")) events.push({ bot: owner, ev: "your-turn", round, t: (t += 10), payload: { attempt: round } });
      all("round-start", round, { photo: `/temp/p${round}.jpg`, duration: 7700 });
      all("round-reveal", round, { correctAnswer: owner });
    });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    console.log(JSON.stringify(analyseRoom(r, { host: true, rounds: 3, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 }).planted_rounds));
  ' "$ANALYSIS" "$1"
}
got="$(planted_rounds none)"
[ "$got" = "[3]" ] && ok "planted_rounds: the planter bot's round only, not the device's" || ko "planted_rounds with a device" "got $got, want [3]"
got="$(planted_rounds bot2-asked)"
[ "$got" = "[]" ] && ok "planted_rounds: a planter's normal turn is not planted" || ko "planted_rounds planter asked" "got $got, want []"
got="$(planted_rounds no-plant)"
[ "$got" = "[]" ] && ok "planted_rounds: no bot planted -> none" || ko "planted_rounds no plant" "got $got, want []"

# ── --quit-after-game-over: the next game drops the bot that quit at game-over (EXP-151) ──
# bot1 (host), bot2, bot3 play a 1-round game; at game-over bot3 quits, the others play again and, once bot3 has been
# gone for the grace, a 1-round second game starts without it. Prints the consistency errors, one per line.
next_game() { # mutation: none | no-player-left | left-after-start | ghost-in-start | ghost-in-scores | ghost-answer |
              #           ghost-guessed | ghost-gets-events | no-second-game-over | no-quit
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const mutation = process.argv[2];
    const players = ["bot1", "bot2", "bot3"];
    const stayers = ["bot1", "bot2"];
    const events = [];
    let t = 0;
    const all = (names, ev, round, payload) => names.forEach((bot) => events.push({ bot, ev, round, t: (t += 10), payload }));
    const scores = (names) => names.map((u) => ({ username: u, points: 0, lastGuess: "", lastAnswerCorrect: false }));
    const playRound = (names, prefix, answer) => {
      all(names, `${prefix}waiting-photo`, 1, { round: 1, duration: 15000 });
      all(names, `${prefix}round-start`, 1, { photo: "/temp/p1.jpg", duration: 7700 });
      all(names, `${prefix}round-reveal`, 1, { correctAnswer: answer });
      all(names, `${prefix}round-scores`, 1, { round: 1, scores: scores(names) });
    };
    all(players, "game-started", 0, { rounds: 1, players });
    playRound(players, "", "bot1");
    all(players, "game-over", 1, { finalScore: scores(players) });
    if (mutation !== "no-quit") all(["bot3"], "quit-after-game-over", 1);
    all(stayers, "play-again-joined", 0, { sameToken: true, isHost: false, started: false, gone: [] });
    all(stayers, "player-connection", 0, { username: "bot3", connected: false });
    if (!["no-player-left", "left-after-start"].includes(mutation)) all(stayers, "player-left", 1, { username: "bot3" });
    all(stayers, "g2-game-started", 0, { rounds: 1, players: mutation === "ghost-in-start" ? players : stayers });
    if (mutation === "left-after-start") all(stayers, "player-left", 1, { username: "bot3" });
    if (mutation === "ghost-gets-events") all(["bot3"], "g2-game-started", 0, { rounds: 1, players });
    if (mutation === "ghost-guessed") all(["bot1"], "g2-guess-sent", 1, { guess: "bot3" });
    playRound(stayers, "g2-", mutation === "ghost-answer" ? "bot3" : "bot2");
    if (mutation === "ghost-in-scores") all(stayers, "g2-round-scores", 1, { round: 1, scores: scores(players) });
    if (mutation !== "no-second-game-over") all(stayers, "g2-game-over", 1, { finalScore: scores(stayers) });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    const opts = { host: true, rounds: 1, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0, quitAfterGameOver: true };
    console.log(analyseRoom(r, opts).consistency_errors.join("\n"));
  ' "$ANALYSIS" "$1"
}
next_game_case() { # label, mutation, expected error text ("" = none)
  local got; got="$(next_game "$2")"
  if [ -z "$3" ]; then [ -z "$got" ] && ok "$1" || ko "$1" "$got"
  else [[ "$got" == *"$3"* ]] && ok "$1" || ko "$1" "expected [$3] in [$got]"; fi
}
next_game_case "quit at game-over: player-left before the next game-started, which has no ghost" none ""
next_game_case "quit: a stayer never told (player-left)" no-player-left "bot1: never got player-left for bot3 (gone since game-over) before the next game"
next_game_case "quit: player-left only after game-started" left-after-start "bot2: player-left for bot3 came after game-started"
next_game_case "quit: the ghost is in the next game-started" ghost-in-start "bot1: bot3 quit after game-over but is in the next game-started"
next_game_case "quit: the ghost is in a next-game round-scores" ghost-in-scores "bot2: bot3 is in a next-game round-scores"
next_game_case "quit: a next-game answer is the ghost" ghost-answer "bot1: a next-game round's answer is bot3"
next_game_case "quit: a stayer guessed the ghost" ghost-guessed "bot1: guessed bot3 in the next game"
next_game_case "quit: the ghost still gets game events" ghost-gets-events "bot3: got g2-game-started after quitting"
next_game_case "quit: the next game never ends" no-second-game-over "bot2: the next game never ended"
next_game_case "quit: nobody quit" no-quit "nobody quit after game-over"

# ── Second game: a device's photo turn skipped (EXP-110) ──
# The recorded device-linger-next-game room (bot1, bot2 and a lingering device that plays the second game), with its
# second game's round 1 skipped AFTER ms after the bots' g2-waiting-photo: the bots only get the room's copy, without a
# reason (the device was the awaited owner). Prints the consistency errors, one per line.
# Variants for bot1 only: "paused" (a rejoin snapshot of the paused wait 2 s in, resumed 58 s later: AFTER counts from
# the waiting-photo, pause included); "missed" (bot1 missed that waiting-photo and rejoined 2 s in with a snapshot of
# the wait, 13 s left: AFTER counts from the snapshot).
device_turn_skipped() { # after ms, variant (none|paused|missed)
  node --input-type=module -e '
    import fs from "node:fs";
    const { analyseRoom } = await import(process.argv[1]);
    const { opts, room } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const after = Number(process.argv[3]);
    const variant = process.argv[4] ?? "none";
    const SNAPSHOT_AT = 2_000, RESUMED_AT = 60_000;
    const snapshot = (bot, t, paused) => ({ bot, ev: "g2-game-state", round: 0, t,
      payload: { phase: "waiting-photo", paused, started: true, duration: 15_000 - SNAPSHOT_AT } });
    for (const wait of room.events.filter((e) => e.ev === "g2-waiting-photo" && e.round === 1)) {
      const mine = wait.bot === "bot1" && variant !== "none";
      if (mine && variant === "paused") {
        room.events.push(snapshot(wait.bot, wait.t + SNAPSHOT_AT, true));
        room.events.push({ bot: wait.bot, ev: "g2-game-resumed", round: 0, t: wait.t + RESUMED_AT, payload: { phase: "waiting-photo" } });
      }
      if (mine && variant === "missed") {
        wait.ev = "g2-waiting-photo-missed"; // never received
        room.events.push(snapshot(wait.bot, wait.t + SNAPSHOT_AT, false));
      }
      const from = mine && variant === "missed" ? wait.t + SNAPSHOT_AT : wait.t;
      room.events.push({ bot: wait.bot, ev: "g2-round-skipped", round: 1, t: from + after, payload: { round: 1 } });
    }
    room.events.sort((a, b) => a.t - b.t);
    console.log(analyseRoom(room, opts).consistency_errors.join("\n"));
  ' "$ANALYSIS" "$FIXTURES/device-linger-next-game.json" "$@"
}
device_turn_case() { # label, has|lacks, expected text, device_turn_skipped args...
  local label="$1" mode="$2" want="$3" got; shift 3
  got="$(device_turn_skipped "$@")"
  if [ "$mode" = has ]; then [[ "$got" == *"$want"* ]] && ok "$label" || ko "$label" "expected [$want] in [$got]"
  else [[ "$got" != *"$want"* ]] && ok "$label" || ko "$label" "unexpected [$want] in [$got]"; fi
}
BOT1_TIMEOUT="bot1: second game round 1 skipped by timeout"
device_turn_case "second game: the device's turn timing out is reported though the bots' copies have no reason" \
  has "$BOT1_TIMEOUT (the lingering device kept it waiting)" 15000
device_turn_case "second game: the device's turn skipped at once is not a timeout" lacks "skipped by timeout" 300
device_turn_case "paused wait (rejoin snapshot of the pause): a skip right after the resume is not a timeout" \
  lacks "$BOT1_TIMEOUT" 60300 paused
device_turn_case "paused wait (rejoin snapshot of the pause): the wait running out after the resume is a timeout" \
  has "$BOT1_TIMEOUT" 73000 paused
device_turn_case "missed waiting-photo: the wait counts from the rejoin snapshot, a skip when it runs out is a timeout" \
  has "$BOT1_TIMEOUT" 13000 missed
device_turn_case "missed waiting-photo: a skip right after the rejoin snapshot is not a timeout" lacks "$BOT1_TIMEOUT" 300 missed

# ── round-skipped privacy (EXP-110): only the copy of a bot asked for that round's photo has a reason ──
skip_leak() { # payload JSON, asked round (or null)
  node --input-type=module -e '
    const { skipReasonLeak } = await import(process.argv[1]);
    console.log(skipReasonLeak(JSON.parse(process.argv[2]), JSON.parse(process.argv[3])) ?? "none");
  ' "$ANALYSIS" "$1" "$2"
}
[ "$(skip_leak '{"round":2}' null)" = none ] && ok "skip privacy: the room's copy (no reason) is fine" || ko "skip privacy: room copy" "$(skip_leak '{"round":2}' null)"
[ "$(skip_leak '{"round":2,"reason":"unavailable"}' 2)" = none ] && ok "skip privacy: the owner's copy has the reason" \
  || ko "skip privacy: owner copy" "$(skip_leak '{"round":2,"reason":"unavailable"}' 2)"
got="$(skip_leak '{"round":2,"reason":"timeout"}' null)"
[[ "$got" == *'reason "timeout" for round 2'* ]] && ok "skip privacy: a reason to a bot not asked for a photo is a leak" || ko "skip privacy: not asked" "$got"
got="$(skip_leak '{"round":2,"reason":"unavailable"}' 1)"
[[ "$got" == *'reason "unavailable" for round 2'* ]] && ok "skip privacy: a reason for another round than the one asked is a leak" || ko "skip privacy: other round" "$got"

# ── --hold: everyone is let go within 1 s of the holder releasing or going away (EXP-303) ──
# A 1-round game of bot1, bot2, bot3: bot1, the round's owner, holds the scoreboard at 10 s and its hold ends at 15 s
# the way `ending` says (released | dropped | rejoined | left); the others get hold-resume + hold-end LAG ms later (the
# holder too on a release). Mutations: no-resume (bot3 never gets hold-resume), offline (bot3 dropped at round-start
# and is still away when the hold ends, so it gets neither). Prints the consistency errors, one per line, then
# "holds=N lag_max=MS" from the summary.
hold() { # ending, lag ms, mutation (none|no-resume|offline)
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const [ending, lagArg, mutation] = process.argv.slice(2);
    const lag = Number(lagArg);
    const players = ["bot1", "bot2", "bot3"];
    const events = [];
    const at = (bot, ev, round, t, payload) => events.push({ bot, ev, round, t, ...(payload !== undefined ? { payload } : {}) });
    const all = (names, ev, round, t, payload) => names.forEach((b) => at(b, ev, round, t, payload));
    const scores = players.map((u) => ({ username: u, points: 0, lastGuess: "", lastAnswerCorrect: false }));
    all(players, "game-started", 0, 0, { rounds: 1, players });
    all(players, "waiting-photo", 1, 500, { round: 1, duration: 15000 });
    at("bot1", "your-turn", 1, 600, { attempt: 1 });
    at("bot1", "photo-sent", 1, 900, { attempt: 1 });
    all(players, "round-start", 1, 1000, { photo: "/temp/p1.jpg", duration: 7700 });
    if (mutation === "offline") at("bot3", "chaos-disconnect", 1, 1001);
    const inRoom = mutation === "offline" ? ["bot1", "bot2"] : players;
    all(inRoom, "round-reveal", 1, 9000, { correctAnswer: "bot1", yourGuess: "" });
    all(inRoom, "round-scores", 1, 9500, { round: 1, scores });
    at("bot1", "hold-sent", 1, 9900);
    all(inRoom, "hold-start", 1, 10000);
    at("bot1", "holding", 1, 10001);
    const END = 15000;
    at("bot1", { released: "hold-release-sent", dropped: "hold-drop", rejoined: "hold-rejoin", left: "left-room" }[ending], 1, END);
    if (ending === "left") all(["bot2", "bot3"], "player-left", 1, END + 1, { username: "bot1" });
    const receivers = inRoom.filter((n) => n !== "bot1" || ending === "released");
    for (const n of receivers) {
      if (!(mutation === "no-resume" && n === "bot3")) at(n, "hold-resume", 1, END + lag, { phase: "scores", duration: 4000, phaseTotal: 5000 });
      at(n, "hold-end", 1, END + lag + 1);
    }
    if (ending === "dropped" || ending === "rejoined") at("bot1", "game-state", 1, END + 2000, { phase: "scores", paused: false, started: true, yourGuess: "" });
    all(players.filter((n) => n !== "bot1" || ending !== "left"), "game-over", 1, END + lag + 5000, { finalScore: [] });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    const summary = analyseRoom(r, { host: true, rounds: 1, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 });
    console.log([...summary.consistency_errors, `holds=${summary.holds} lag_max=${summary.hold_release_ms.max}`].join("\n"));
  ' "$ANALYSIS" "$@"
}
hold_case() { # label, expected text (a clean run: "holds=1 lag_max=..."), hold args...
  local label="$1" want="$2" got; shift 2
  got="$(hold "$@")"
  [[ "$got" == *"$want"* ]] && ok "$label" || ko "$label" "expected [$want] in [$got]"
}
[ "$(hold released 20 none)" = "holds=1 lag_max=21.0" ] && ok "hold released: everyone, the holder too, let go on time" || ko "hold released on time: no error" "$(hold released 20 none)"
hold_case "hold released but hold-end 1.5 s later" "round 1: bot2 got hold-end 1501 ms after bot1 released while holding (max 1000 ms)" released 1500 none
[ "$(hold dropped 20 none)" = "holds=1 lag_max=21.0" ] && ok "holder drop on time: no consistency error" || ko "holder drop on time: no error" "$(hold dropped 20 none)"
[ "$(hold left 20 none)" = "holds=1 lag_max=21.0" ] && ok "holder leaves while holding, let go on time: no consistency error" || ko "holder leave on time: no error" "$(hold left 20 none)"
[ "$(hold rejoined 20 none)" = "holds=1 lag_max=21.0" ] && ok "holder rejoins on a new socket, let go on time: no consistency error" || ko "holder rejoin on time: no error" "$(hold rejoined 20 none)"
hold_case "holder rejoins on a new socket and the room stays frozen (EXP-299)" "round 1: bot2 got hold-end 25001 ms after bot1 rejoined on a new socket while holding (max 1000 ms)" rejoined 25000 none
hold_case "a player never gets hold-resume" "round 1: bot3 never got hold-resume after bot1 dropped while holding" dropped 20 no-resume
[ "$(hold released 20 offline)" = "holds=1 lag_max=21.0" ] && ok "a player away when the hold ends is not expected to get it" || ko "offline player excluded" "$(hold released 20 offline)"

# Holds the server ends first: a 2-round game of bot1 and bot2 whose photos are both bot1's; bot1 holds round 1 at 10 s
# and the server ends it at 12 s (hold-end, recorded by bot1 as hold-ended-by-server); bot1 holds round 2 from 30 s and
# releases it at 55 s. Each
# hold is counted once and judged on its own events (round 1's must not be paired with round 2's release).
# `round1`: server-ended (hold-end only, no hold-resume nor pause: hold-resume is missing) | paused (bot2 drops, the
# pause ends the hold: hold-end then game-paused to bot1, no hold-resume due). Prints errors, then holds/lag as above.
server_ended_hold() { # round1
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const round1 = process.argv[2];
    const players = ["bot1", "bot2"];
    const events = [];
    const at = (bot, ev, round, t, payload) => events.push({ bot, ev, round, t, ...(payload !== undefined ? { payload } : {}) });
    const all = (names, ev, round, t, payload) => names.forEach((b) => at(b, ev, round, t, payload));
    const scores = players.map((u) => ({ username: u, points: 0, lastGuess: "", lastAnswerCorrect: false }));
    const playUntilScores = (round, owner, t0) => {
      all(players, "waiting-photo", round, t0, { round, duration: 15000 });
      at(owner, "your-turn", round, t0 + 100, { attempt: round });
      at(owner, "photo-sent", round, t0 + 400, { attempt: round });
      all(players, "round-start", round, t0 + 500, { photo: `/temp/p${round}.jpg`, duration: 7700 });
      all(players, "round-reveal", round, t0 + 8500, { correctAnswer: owner, yourGuess: "" });
      all(players, "round-scores", round, t0 + 9000, { round, scores });
    };
    const holdAt = (owner, round, t) => {
      at(owner, "hold-sent", round, t - 100);
      all(players, "hold-start", round, t);
      at(owner, "holding", round, t + 1);
    };
    all(players, "game-started", 0, 0, { rounds: 2, players });
    playUntilScores(1, "bot1", 500);
    holdAt("bot1", 1, 10000);
    if (round1 === "paused") {
      at("bot2", "chaos-disconnect", 1, 11990);
      at("bot1", "hold-end", 1, 12000);
      at("bot1", "hold-ended-by-server", 1, 12000);
      at("bot1", "game-paused", 1, 12005, { waitingFor: ["bot2"], duration: 300000, pause: 1, maxPauses: 3 });
      at("bot2", "game-state", 1, 14000, { phase: "scores", paused: false, started: true });
      at("bot1", "game-resumed", 1, 14100, { phase: "scores" });
    } else {
      all(players, "hold-end", 1, 12000);
      at("bot1", "hold-ended-by-server", 1, 12000);
    }
    playUntilScores(2, "bot1", 20000);
    holdAt("bot1", 2, 30000);
    at("bot1", "hold-release-sent", 2, 55000);
    all(players, "hold-resume", 2, 55020, { phase: "scores", duration: 4000, phaseTotal: 5000 });
    all(players, "hold-end", 2, 55021);
    all(players, "game-over", 2, 60000, { finalScore: [] });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    const summary = analyseRoom(r, { host: true, rounds: 2, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 });
    console.log([...summary.consistency_errors, `holds=${summary.holds} lag_max=${summary.hold_release_ms.max}`].join("\n"));
  ' "$ANALYSIS" "$1"
}
want=$'round 1: bot1 never got hold-resume after the server ended bot1\'s hold\nround 1: bot2 never got hold-resume after the server ended bot1\'s hold\nholds=2 lag_max=21.0'
got="$(server_ended_hold server-ended)"
[ "$got" = "$want" ] && ok "hold ended by the server without hold-resume: reported in its own round, each hold counted once" || ko "server-ended hold" "expected [$want] got [$got]"
got="$(server_ended_hold paused)"
[ "$got" = "holds=2 lag_max=21.0" ] && ok "hold ended by a pause: hold-end only, no hold-resume due" || ko "pause-ended hold" "$got"
echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
