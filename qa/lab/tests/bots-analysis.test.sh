#!/usr/bin/env bash
# qa/lab/bots-analysis.mjs, the checks and metrics of a bots room (no network):
# - characterization (EXP-247): every fixture in fixtures/bots-analysis/ (anonymised events of real runs, plus broken
#   variants and synthetic games so that each check function reports at least one error: dropping any of them from
#   analyseRoom fails this test) must give exactly the summary the original analyse() of bots.mjs gave (`expected`),
#   errors in the same order. lab.sh, bots-cli.test.sh and the dashboard read that JSON. The fixtures were recorded
#   with an 8 s answer timer (300 ms grace); EXP-306 made it 8.5 s (800 ms grace) with the same 7.7 s `duration`, so
#   their answer_phase_overrun_ms reads ~500 ms early (reveals came sooner than today's server sends them).
# - players out of the room (EXP-139): leave (--leave-round), lobby kick (--kick) and kick after the game
#   (--kick-after-game, EXP-346) checks on small synthetic games, and the
#   photo owner leaving during their round (--leave-owner, EXP-301 / DEC-038): still the answer, voters score.
# - holds of the scoreboard (--hold, EXP-303): everyone let go within 1 s of the holder releasing or going away, and
#   every hold-end tells the holds left (EXP-176), and the rounds whose owner used up its holds (EXP-371).
# - game numbers (EXP-318): every photo wait and snapshot of a game carries its game-started number, and the next
#   game's is higher.
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
# the lobby (a bot, or a device "ios-a" the bots only see the notice of), at round 2 ("in-game-kick", "owner-kicked":
# --kick-in-game 2, EXP-425) or, in
# "after-game-kick" (--kick-after-game, EXP-346), at game over after bot3 played every round; the
# mutation breaks it. In "owner-left" bot3 leaves while its own photo is round 2's, and bot2 votes for it after it left. Prints the consistency errors, one per line, and who has missed events (a player out of the
# room misses the rest of the game on purpose, so a clean game prints nothing).
exits() { # scenario (left|owner-left|lobby-kick|lobby-kick-device|after-game-kick|in-game-kick|owner-kicked), mutation (none|...)
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
    const afterGameKick = scenario.startsWith("after-game-kick");
    // "after-game-kick-host-drop": bot1 (the host) drops in the lobby for good, bot2 hosts the game and kicks after it
    const hostDropped = scenario === "after-game-kick-host-drop";
    const kicker = hostDropped ? "bot2" : "bot1";
    const live = players.filter((n) => !(hostDropped && n === "bot1"));
    if (hostDropped) {
      // The handover after the 15 s grace, as the server sends it (checkLobbyHostDrop)
      at("bot1", "lobby-host-drop", 0);
      t += 16000;
      all(live, "player-connection", 0, { username: "bot1", connected: false });
      all(live, "new-host", 0, { username: "bot2" });
    }
    const inGame = lobbyKick ? players.filter((n) => n !== out) : live;
    const bots = (names) => names.filter((n) => players.includes(n));
    const leaves = scenario === "left" || scenario === "owner-left";
    // EXP-425: the host removes bot3 at round 2 round-start (--kick-in-game 2), as a leave; "owner-kicked": its photo
    const kicksInGame = scenario === "in-game-kick" || scenario === "owner-kicked";
    const ownerLeftIn = (round) => (scenario === "owner-left" || scenario === "owner-kicked") && round === 2;
    const points = new Map();
    // The host removes `out`; bots.mjs records it at the last round the host played (0 in the lobby before the game)
    const kickOut = (round) => {
      at(kicker, "kick-sent", round, { username: out });
      if (mutation !== "no-notice") all(live, "player-removed", round, { username: out });
      if (out === "bot3" && mutation !== "still-connected") {
        at("bot3", "kicked-out", round, { reason: "io server disconnect" });
        // EXP-337: back with its old token, refused with "Removed by host"
        if (mutation !== "no-kick-rejoin-refusal") at("bot3", "kick-rejoin-refused", round, { message: "Removed by host" });
      }
    };
    if (lobbyKick) {
      kickOut(0);
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
      if (round === 2 && kicksInGame) {
        kickOut(2);
        room = ["bot1", "bot2"];
      }
      // Kicked after the game: it played every round, and round 2 had its photo
      const answer = mutation === "answer-after-exit" && round === 3 ? out
        : (ownerLeftIn(round) && mutation !== "owner-not-answer") || (afterGameKick && round === 2) ? "bot3" : "bot1";
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
    if (afterGameKick) kickOut(mutation === "kick-tagged-lobby" ? 0 : 3);
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
expect_error "kick: the kicked bot's rejoin with its old token is never refused (EXP-337)" lobby-kick no-kick-rejoin-refusal \
  "bot3: no \"Removed by host\" refusal for its rejoin with the old token after being kicked"
expect_error "lobby kick: the kicked bot is in game-started" lobby-kick in-game-started "bot1: bot3 was removed but is in game-started"
expect_error "lobby kick: the kicked bot gets game-started" lobby-kick events-after-kick "bot3: got game-started after being kicked"
expect_clean "a bot kicked after the game: the rounds it played are not after its exit" after-game-kick
expect_clean "a bot kicked at round 2 (EXP-425): the game goes on without it" in-game-kick
expect_clean "the owner kicked during its round: still the answer, a vote for it after the kick scores" owner-kicked
expect_error "in-game kick: a stayer never told (player-removed)" in-game-kick no-notice "bot2: never got player-removed for bot3"
expect_error "in-game kick: still in a later round-scores" in-game-kick scores-after-exit "bot1: bot3 was removed but is still in round-scores"
expect_error "in-game kick: guessed in a later round" in-game-kick guess-after-exit "bot2: guessed bot3 after it was removed"
expect_error "in-game kick: no round after the kick" in-game-kick game-stopped "bot1: no round after round 2, when bot3 was removed"
expect_error "in-game kick: the kicked bot's rejoin is never refused" in-game-kick no-kick-rejoin-refusal \
  "bot3: no \"Removed by host\" refusal for its rejoin with the old token after being kicked"
expect_error "owner kicked: a vote for it scored without its point" owner-kicked owner-point-missing \
  "round 2: bot2 voted bot3, the owner who left, but was scored correct with 0 point(s)"
# The host dropped in the lobby (--lobby-host-drop): the new host kicks, and the dropped one is not expected to be told
# (it is offline; it misses the whole game on purpose, the only missed events)
got="$(exits after-game-kick-host-drop none)"
[[ "$got" =~ ^"missed events: bot1 ["[^]]*"]"$ ]] && ok "kick after the game by the new host: the host that dropped in the lobby is not expected to be told" \
  || ko "kick after the game by the new host" "$got"
expect_error "kick after the game by the new host: a stayer never told" after-game-kick-host-drop no-notice "bot2: never got player-removed for bot3"
expect_error "kick after the game: a stayer never told (player-removed)" after-game-kick no-notice "bot2: never got player-removed for bot3"
expect_error "kick after the game: the kicked bot's rejoin with its old token is never refused" after-game-kick no-kick-rejoin-refusal \
  "bot3: no \"Removed by host\" refusal for its rejoin with the old token after being kicked"
# Why bots.mjs records a kick at the host's last round: tagged round 0, the game the player was in reads as after it
expect_error "kick after the game tagged round 0: a round it played reads as after the kick" after-game-kick kick-tagged-lobby \
  "round 2: the answer is bot3, who was removed in round 0"
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
# holder too on a release), hold-end saying 2 holds are left. Mutations: no-resume (bot3 never gets hold-resume),
# offline (bot3 dropped at round-start and is still away when the hold ends, so it gets neither), no-holds-left (bot3's
# hold-end has no holdsLeft), too-many-left (bot3's says 3 after a hold), held-when-used-up (hold-end says 0, then the
# server starts another hold), snapshot-no-holds-left / snapshot-too-many-left (the snapshot bot1 gets back after
# dropping or rejoining has no holdsLeft, or says 3; it says 2 otherwise). EXP-354, after the hold the room gets
# hold-closed (the scoreboard is down to 1.5 s) and that snapshot says 0: closed (nothing else), held-after-closed (the
# server starts another hold), snapshot-after-closed (the snapshot still says 2), next-game (the room plays again and
# round 1 of the new game is held: no longer the closed one). Prints the consistency errors, one per line, then
# "holds=N lag_max=MS" from the summary.
hold() { # ending, lag ms, mutation (none|no-resume|offline|no-holds-left|too-many-left|held-when-used-up|snapshot-*|*closed|next-game)
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
      const ended = { "no-holds-left": {}, "too-many-left": { holdsLeft: 3 }, "held-when-used-up": { holdsLeft: 0 } }[mutation];
      at(n, "hold-end", 1, END + lag + 1, ended && (n === "bot3" || mutation === "held-when-used-up") ? ended : { holdsLeft: 2 });
    }
    if (mutation === "held-when-used-up") all(inRoom, "hold-start", 1, END + lag + 100);
    const closed = ["closed", "held-after-closed", "snapshot-after-closed", "next-game"].includes(mutation);
    if (closed) all(inRoom, "hold-closed", 1, END + lag + 50);
    if (mutation === "held-after-closed") all(inRoom, "hold-start", 1, END + lag + 100);
    const snapshotHoldsLeft = { "snapshot-no-holds-left": {}, "snapshot-too-many-left": { holdsLeft: 3 } }[mutation]
      ?? { holdsLeft: closed && mutation !== "snapshot-after-closed" ? 0 : 2 };
    if (ending === "dropped" || ending === "rejoined") at("bot1", "game-state", 1, END + 2000, { phase: "scores", paused: false, started: true, yourGuess: "", ...snapshotHoldsLeft });
    all(players.filter((n) => n !== "bot1" || ending !== "left"), "game-over", 1, END + lag + 5000, { finalScore: [] });
    if (mutation === "next-game") {
      all(inRoom, "game-started", 0, END + lag + 6000, { rounds: 1, players });
      all(inRoom, "hold-start", 1, END + lag + 7000);
    }
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
# EXP-176: hold-end says how many holds are left, and the server keeps to it
hold_case "a hold-end without holdsLeft" "round 1: bot3 got hold-end with holdsLeft undefined (expected 0 to 2)" released 20 no-holds-left
hold_case "a hold-end with more holds left than the round has" "round 1: bot3 got hold-end with holdsLeft 3 (expected 0 to 2)" released 20 too-many-left
hold_case "a hold the server starts after saying none are left" "round 1: bot2 got hold-start after hold-end said no holds were left" released 20 held-when-used-up
hold_case "a scoreboard snapshot without holdsLeft" "round 1: bot1 got a scoreboard snapshot with holdsLeft undefined (expected 0 to 2)" dropped 20 snapshot-no-holds-left
hold_case "a scoreboard snapshot with more holds left than the round has" "round 1: bot1 got a scoreboard snapshot with holdsLeft 3 (expected 0 to 2)" rejoined 20 snapshot-too-many-left
# EXP-354: hold-closed says no more holds this round, like a hold-end with 0
[ "$(hold dropped 20 closed)" = "holds=1 lag_max=21.0" ] && ok "hold-closed after the hold, snapshot says 0: no consistency error" || ko "hold-closed: no error" "$(hold dropped 20 closed)"
hold_case "a hold the server starts after hold-closed" "round 1: bot2 got hold-start after hold-closed said no holds were left" released 20 held-after-closed
hold_case "a scoreboard snapshot after hold-closed with holds left" "round 1: bot1 got a scoreboard snapshot with holdsLeft 2 (expected 0 to 0)" rejoined 20 snapshot-after-closed
got="$(hold released 20 next-game)"
[[ "$got" != *"said no holds were left"* ]] && ok "the next game's round 1 is not the closed one" || ko "hold-closed per game" "$got"

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
      at("bot1", "hold-end", 1, 12000, { holdsLeft: 2 });
      at("bot1", "hold-ended-by-server", 1, 12000);
      at("bot1", "game-paused", 1, 12005, { waitingFor: ["bot2"], duration: 300000, pause: 1, maxPauses: 3 });
      at("bot2", "game-state", 1, 14000, { phase: "scores", paused: false, started: true, holdsLeft: 2 });
      at("bot1", "game-resumed", 1, 14100, { phase: "scores" });
    } else {
      all(players, "hold-end", 1, 12000, { holdsLeft: 0 });
      at("bot1", "hold-ended-by-server", 1, 12000);
    }
    playUntilScores(2, "bot1", 20000);
    holdAt("bot1", 2, 30000);
    at("bot1", "hold-release-sent", 2, 55000);
    all(players, "hold-resume", 2, 55020, { phase: "scores", duration: 4000, phaseTotal: 5000 });
    all(players, "hold-end", 2, 55021, { holdsLeft: 2 });
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

# ── holds_used_up: the rounds whose owner used up its holds, as the bots heard them (EXP-371) ──
# A 2-round game of bot1 and bot2 with the device ios-a, whose photo is round 1's (bot1's round 2's): ios-a holds round
# 1 three times, each hold-end telling the holds left (2, 1, 0), and bot1 holds round 2 once. Variants: two-holds (ios-a
# holds twice and the second hold-end says 0, as when the hold budget runs out), missed (bot2 was away for the first
# hold: bot1 still heard all three), second-game (the same holds, recorded as a second game's "g2-" events). Prints the
# summary's holds_used_up.
used_up() { # variant (three-holds|two-holds|missed|second-game)
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const variant = process.argv[2];
    const bots = ["bot1", "bot2"];
    const events = [];
    const g = variant === "second-game" ? "g2-" : "";
    const at = (bot, ev, round, t, payload) => events.push({ bot, ev: g + ev, round, t, ...(payload !== undefined ? { payload } : {}) });
    const all = (ev, round, t, payload, names = bots) => names.forEach((b) => at(b, ev, round, t, payload));
    all("game-started", 0, 0, { rounds: 2, players: [...bots, "ios-a"] });
    const scoreboard = (round, owner, t0) => {
      all("round-start", round, t0, { photo: `/temp/p${round}.jpg`, duration: 7700 });
      all("round-reveal", round, t0 + 8000, { correctAnswer: owner, yourGuess: "" });
      all("round-scores", round, t0 + 11000, { round, scores: [] });
    };
    scoreboard(1, "ios-a", 0);
    const holdsLeft = variant === "two-holds" ? [2, 0] : [2, 1, 0];
    holdsLeft.forEach((left, i) => {
      const heard = variant === "missed" && i === 0 ? ["bot1"] : bots;
      all("hold-start", 1, 11100 + i * 100, undefined, heard);
      all("hold-end", 1, 11150 + i * 100, { holdsLeft: left }, heard);
    });
    scoreboard(2, "bot1", 20000);
    at("bot1", "hold-sent", 2, 31050);
    all("hold-start", 2, 31100);
    at("bot1", "holding", 2, 31101);
    at("bot1", "hold-release-sent", 2, 31150);
    all("hold-resume", 2, 31160, { phase: "scores", duration: 4000, phaseTotal: 5000 });
    all("hold-end", 2, 31161, { holdsLeft: 2 });
    all("game-over", 2, 40000, { finalScore: [] });
    const r = { code: "QAROOM", reason: "game-over", players: bots, errors: [], uploads: [], rateLimited: 0, events };
    console.log(JSON.stringify(analyseRoom(r, { host: true, rounds: 2 }).holds_used_up));
  ' "$ANALYSIS" "$1"
}
got="$(used_up three-holds)"
[ "$got" = '[{"owner":"ios-a","round":1}]' ] && ok "holds_used_up: the device's round after its 3 holds, not a bot's round held once" \
  || ko "holds_used_up after 3 holds" "$got"
got="$(used_up two-holds)"
[ "$got" = '[]' ] && ok "holds_used_up: a hold-end saying 0 after fewer holds doesn't count" || ko "holds_used_up after 2 holds" "$got"
got="$(used_up missed)"
[ "$got" = '[{"owner":"ios-a","round":1}]' ] && ok "holds_used_up: one bot that heard all 3 holds is enough" || ko "holds_used_up, a bot away" "$got"
got="$(used_up second-game)"
[ "$got" = '[]' ] && ok "holds_used_up: only the first game's rounds" || ko "holds_used_up in a second game" "$got"

# ── Tie with points (--answer-right, EXP-348) ──
# A synthetic game of our bots bot1 and bot2 plus the players in OTHERS (devices), one round per owner in OWNERS
# ("-": skipped, no reveal), ending on FINAL ("name:points,..."). With GAME2_OWNERS / GAME2_FINAL a second game
# follows, recorded as "g2-<event>". Prints the "tie:" errors of the room, one per line.
tie_room() { # others owners final [game2-owners game2-final]
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const [others, owners, final, g2Owners, g2Final] = process.argv.slice(2);
    const players = ["bot1", "bot2"];
    const everyone = [...players, ...others.split(",").filter(Boolean)];
    const events = [];
    let t = 0;
    const all = (ev, round, payload) => players.forEach((bot) => events.push({ bot, ev, round, t: (t += 10), payload }));
    const scores = (spec) => spec.split(",").map((p) => { const [username, points] = p.split(":"); return { username, points: Number(points) }; });
    const playGame = (prefix, ownerList, finalSpec) => {
      all(`${prefix}game-started`, 0, { rounds: ownerList.split(",").length, players: everyone });
      ownerList.split(",").forEach((owner, i) => {
        const round = i + 1;
        all(`${prefix}waiting-photo`, round, { round, duration: 15000 });
        if (owner === "-") { all(`${prefix}round-skipped`, round, { round }); return; }
        all(`${prefix}round-start`, round, { photo: `/temp/p${round}.jpg`, duration: 7700 });
        all(`${prefix}round-reveal`, round, { correctAnswer: owner, yourGuess: owner });
      });
      all(`${prefix}game-over`, ownerList.split(",").length, { finalScore: scores(finalSpec) });
    };
    playGame("", owners, final);
    if (g2Owners) playGame("g2-", g2Owners, g2Final);
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    const opts = { host: true, rounds: 3, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0, answerRight: true };
    console.log(analyseRoom(r, opts).consistency_errors.filter((e) => e.includes("tie:")).join("\n"));
  ' "$ANALYSIS" "$@"
}
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:3,bot2:3,ios-a:0)"
[ -z "$got" ] && ok "tie with points: the bots on one point per round, the device on 0" || ko "tie with points passes" "$got"
got="$(tie_room ios-a,android-a android-a,bot1,ios-a bot1:1,bot2:1,ios-a:0,android-a:0)"
[ -z "$got" ] && ok "two devices: only the bots' own rounds count" || ko "two devices: own rounds count" "$got"
got="$(tie_room ios-a,android-a android-a,bot1,ios-a bot1:1,bot2:1,ios-a:0)"
[ -z "$got" ] && ok "a device that left mid-game still counts as another player (from game-started)" || ko "left device counted from game-started" "$got"
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:3,bot2:2,ios-a:0)"
[ "$got" = "tie: the bots are not tied (bot1 3, bot2 2)" ] && ok "bots not tied: reported" || ko "bots not tied reported" "$got"
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:2,bot2:2,ios-a:0)"
[ "$got" = "tie: the bots should all have 3 points, one per round they could tell (bot1 2, bot2 2)" ] \
  && ok "tied on fewer points than rounds they could tell: reported" || ko "tied on too few points reported" "$got"
got="$(tie_room ios-a -,-,- bot1:0,bot2:0,ios-a:0)"
[ "$got" = "tie: no round scored, the game has no result (bot1 0, bot2 0)" ] && ok "everyone on 0 (no result, DEC-044): reported" || ko "all on 0 reported" "$got"
got="$(tie_room ios-a,android-a ios-a,android-a,ios-a bot1:0,bot2:0,ios-a:0,android-a:0)"
[ "$got" = "tie: no round scored, the game has no result (bot1 0, bot2 0)" ] && ok "no round the bots could tell: reported as no result" || ko "no known round reported" "$got"
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:3,ios-a:0)"
[ "$got" = $'tie: bot2 is missing from the final score' ] && ok "a bot missing from the final score: reported" || ko "missing bot reported" "$got"
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:3,bot2:3,ios-a:0 bot1,ios-a bot1:2,bot2:2,ios-a:0)"
[ -z "$got" ] && ok "second game: its own g2-round-reveal rounds count" || ko "second game counted on its own" "$got"
got="$(tie_room ios-a ios-a,bot2,ios-a bot1:3,bot2:3,ios-a:0 bot1,ios-a bot1:3,bot2:3,ios-a:0)"
[ "$got" = "second game: tie: the bots should all have 2 points, one per round they could tell (bot1 3, bot2 3)" ] \
  && ok "second game: a wrong count is reported as the second game's" || ko "second game wrong count reported" "$got"

# ── Game numbers (EXP-318) ──
# bot1 (host) and bot2 play game 1 (number 1), which ends in round 1; they play again (game 2) and bot2 rejoins with a
# snapshot of it. The mutation breaks the numbering. Prints checkGameNumbers' errors (the run's only ones), one per line.
game_numbers() { # mutation: none | legacy (no numbers recorded) | same-number | wait-of-old-game | no-number-in-wait | snapshot-of-old-game
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const mutation = process.argv[2];
    const players = ["bot1", "bot2"];
    const events = [];
    let t = 0;
    const all = (ev, round, payload) => players.forEach((bot) => events.push({ bot, ev, round, t: (t += 10), payload }));
    const numbered = (payload, gameNumber) => (mutation === "legacy" ? payload : { ...payload, gameNumber });
    const scores = players.map((u) => ({ username: u, points: 0, lastGuess: "", lastAnswerCorrect: false }));
    all("game-started", 0, numbered({ rounds: 1, players }, 1));
    all("waiting-photo", 1, numbered({ round: 1, duration: 15000 }, 1));
    all("game-over", 1, { finalScore: scores });
    all("g2-game-started", 0, numbered({ rounds: 1, players }, mutation === "same-number" ? 1 : 2));
    const wait = numbered({ round: 1, duration: 15000 }, mutation === "wait-of-old-game" ? 1 : 2);
    if (mutation === "no-number-in-wait") delete wait.gameNumber;
    all("g2-waiting-photo", 1, wait);
    const snapNumber = mutation === "snapshot-of-old-game" ? 1 : 2;
    events.push({ bot: "bot2", ev: "g2-game-state", round: 0, t: (t += 10), payload: numbered({ phase: "waiting-photo", started: true, paused: false, duration: 9000 }, snapNumber) });
    const r = { code: "QAROOM", reason: "game-over", players, errors: [], uploads: [], rateLimited: 0, events };
    const opts = { host: true, rounds: 1, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 };
    console.log(analyseRoom(r, opts).consistency_errors.filter((e) => e.includes("game number")).join("\n"));
  ' "$ANALYSIS" "$1"
}
game_number_case() { # label, mutation, expected error text ("" = none)
  local got; got="$(game_numbers "$2")"
  if [ -z "$3" ]; then [ -z "$got" ] && ok "$1" || ko "$1" "$got"
  else [[ "$got" == *"$3"* ]] && ok "$1" || ko "$1" "expected [$3] in [$got]"; fi
}
game_number_case "game numbers: each game's waits and snapshots carry its game-started number" none ""
game_number_case "game numbers: a run recorded before they existed is not checked" legacy ""
game_number_case "game numbers: the next game reuses the number" same-number "bot1: g2-game-started has game number 1, not above the previous game's 1"
game_number_case "game numbers: a wait with the previous game's number" wait-of-old-game "bot2: g2-waiting-photo of round 1 has game number 1, its game-started 2"
game_number_case "game numbers: a wait without one" no-number-in-wait "bot1: g2-waiting-photo of round 1 has game number undefined, its game-started 2"
game_number_case "game numbers: a snapshot with the previous game's number" snapshot-of-old-game "bot2: g2-game-state of round 0 has game number 1, its game-started 2"
# waiting-photo must be exactly { round, duration, gameNumber }: an extra key leaks, a missing one is reported too
# (a run with no game number anywhere was recorded before EXP-318 and is held to { round, duration })
waiting_photo_keys() { # mutation: none | owner | no-round | no-duration | no-game-number | legacy
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const mutation = process.argv[2];
    const payload = { round: 1, duration: 15000, gameNumber: 1 };
    if (mutation === "owner") payload.owner = "bot1";
    const dropped = { "no-round": "round", "no-duration": "duration", "no-game-number": "gameNumber", legacy: "gameNumber" }[mutation];
    if (dropped) delete payload[dropped];
    const events = [{ bot: "bot1", ev: "waiting-photo", round: 1, t: 1, payload }];
    // A numbered game start, so only the waiting-photo itself can be missing its number
    if (mutation !== "legacy") events.unshift({ bot: "bot1", ev: "game-started", round: 0, t: 0, payload: { rounds: 1, players: ["bot1"], gameNumber: 1 } });
    const r = { code: "QAROOM", reason: "game-over", players: ["bot1"], errors: [], uploads: [], rateLimited: 0, events };
    console.log(analyseRoom(r, { host: true, rounds: 1, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 }).consistency_errors.filter((e) => e.includes("waiting-photo payload")).join("\n"));
  ' "$ANALYSIS" "$1"
}
waiting_photo_keys_case() { # label, mutation, expected output ("" = no error)
  local got; got="$(waiting_photo_keys "$2")"
  [ "$got" = "$3" ] && ok "$1" || ko "$1" "expected [$3], got [$got]"
}
waiting_photo_keys_case "waiting-photo keys: round, duration and game number are allowed" none ""
waiting_photo_keys_case "waiting-photo keys: an owner leaks" owner "bot1: waiting-photo payload has keys [duration,gameNumber,owner,round] (owner must stay secret)"
waiting_photo_keys_case "waiting-photo keys: a missing round is reported" no-round "bot1: waiting-photo payload of round 1 lacks [round]"
waiting_photo_keys_case "waiting-photo keys: a missing duration is reported" no-duration "bot1: waiting-photo payload of round 1 lacks [duration]"
waiting_photo_keys_case "waiting-photo keys: a missing game number is reported" no-game-number "bot1: waiting-photo payload of round 1 lacks [gameNumber]"
waiting_photo_keys_case "waiting-photo keys: a run from before game numbers needs only round and duration" legacy ""

# ── Rejoin answer (EXP-388): a game-state snapshot, or the game-over of a rejoin that finds the bot alone (DEC-011) ──
# bot1, alone in the room after the device left the pause, drops in round 2 for 60 s (t=1000, back at 61000). The
# mutation picks what it gets after that. Prints checkPlannedDrops' rejoin error, if any.
rejoin_answer() { # mutation: game-over (the it203 shape) | snapshot | none | earlier-game-over | second-game-over | late-game-over |
  # not-alone (a game-over in the window whose final score still has the device: a normal end, not the lone rejoin)
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const mutation = process.argv[2];
    const dropAt = 1000, secs = 60, backAt = dropAt + secs * 1000;
    const finalScore = [{ username: "bot1", points: 1, isHost: true, lastAnswerCorrect: false, lastGuess: "" }];
    const events = [{ bot: "bot1", ev: "game-started", round: 0, t: 0, payload: { rounds: 3, players: ["bot1", "ios-a"] } }];
    if (mutation === "earlier-game-over") events.push({ bot: "bot1", ev: "game-over", round: 1, t: 500, payload: { finalScore } });
    events.push({ bot: "bot1", ev: "planned-disconnect", round: 2, t: dropAt, payload: { secs } });
    const after = {
      "game-over": { ev: "game-over", t: backAt + 6 },
      snapshot: { ev: "game-state", t: backAt + 10, payload: { started: true, phase: "answering", paused: false } },
      "second-game-over": { ev: "g2-game-over", t: backAt + 6 },
      "late-game-over": { ev: "game-over", t: backAt + 5000 },
      "not-alone": { ev: "game-over", t: backAt + 6, payload: { finalScore: [...finalScore, { username: "ios-a", points: 0, isHost: false, lastAnswerCorrect: false, lastGuess: "" }] } },
    }[mutation];
    if (after) events.push({ bot: "bot1", round: 2, payload: { finalScore }, ...after });
    const r = { code: "QAROOM", reason: "game-over", players: ["bot1"], errors: [], uploads: [], rateLimited: 0, events };
    const opts = { host: true, rounds: 3, playAgainLingerS: 0, lingerBot: 0, startNextGameS: 0 };
    console.log(analyseRoom(r, opts).consistency_errors.filter((e) => e.includes("rejoined without")).join("\n"));
  ' "$ANALYSIS" "$1"
}
rejoin_answer_case() { # label, mutation, expected output ("" = no error)
  local got; got="$(rejoin_answer "$2")"
  [ "$got" = "$3" ] && ok "$1" || ko "$1" "expected [$3], got [$got]"
}
REJOIN_UNANSWERED="bot1 rejoined without a game-state snapshot or game-over"
rejoin_answer_case "rejoin answer: the game-over of a rejoin that finds the bot alone counts" game-over ""
rejoin_answer_case "rejoin answer: a game-state snapshot counts" snapshot ""
rejoin_answer_case "rejoin answer: neither snapshot nor game-over is reported" none "$REJOIN_UNANSWERED"
rejoin_answer_case "rejoin answer: a game-over before the drop does not count" earlier-game-over "$REJOIN_UNANSWERED"
rejoin_answer_case "rejoin answer: the second game's game-over does not count" second-game-over "$REJOIN_UNANSWERED"
rejoin_answer_case "rejoin answer: a game-over long after the rejoin does not count" late-game-over "$REJOIN_UNANSWERED"
rejoin_answer_case "rejoin answer: a game-over with other players in its final score does not count" not-alone "$REJOIN_UNANSWERED"
echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
