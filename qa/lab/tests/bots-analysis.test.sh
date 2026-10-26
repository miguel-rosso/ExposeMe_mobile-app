#!/usr/bin/env bash
# qa/lab/bots-analysis.mjs, the checks and metrics of a bots room (no network):
# - characterization (EXP-247): every fixture in fixtures/bots-analysis/ (anonymised events of real runs, plus broken
#   variants and synthetic games so that each check function reports at least one error: dropping any of them from
#   analyseRoom fails this test) must give exactly the summary the original analyse() of bots.mjs gave (`expected`),
#   errors in the same order. lab.sh, bots-cli.test.sh and the dashboard read that JSON.
# - players out of the room (EXP-139): leave (--leave-round) and kick (--kick) checks on small synthetic games.
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
# A synthetic 3-round game of bot1 (host), bot2, bot3 where one player goes out at round 2 (or in the lobby); the
# mutation breaks it. Prints the consistency errors, one per line, and who has missed events (a player out of the
# room misses the rest of the game on purpose, so a clean game prints nothing).
exits() { # scenario (left|kicked|kicked-device|lobby-kick), mutation (none|...)
  node --input-type=module -e '
    const { analyseRoom } = await import(process.argv[1]);
    const [scenario, mutation] = process.argv.slice(2);
    const players = ["bot1", "bot2", "bot3"];
    const events = [];
    let t = 0;
    const at = (bot, ev, round, payload) => events.push({ bot, ev, round, t: (t += 10), ...(payload !== undefined ? { payload } : {}) });
    const all = (names, ev, round, payload) => names.forEach((n) => at(n, ev, round, typeof payload === "function" ? payload(n) : payload));
    const out = scenario === "kicked-device" ? "ios-a" : "bot3";
    const lobbyKick = scenario === "lobby-kick";
    const inGame = lobbyKick ? ["bot1", "bot2"] : [...players, ...(out === "ios-a" ? [out] : [])];
    const bots = (names) => names.filter((n) => players.includes(n));
    if (lobbyKick) {
      at("bot1", "kick-sent", 0, { username: "bot3" });
      all(players, "player-removed", 0, { username: "bot3" });
      if (mutation !== "still-connected") at("bot3", "kicked-out", 0, { reason: "io server disconnect" });
      if (mutation === "events-after-kick") at("bot3", "game-started", 0, { rounds: 3, players: ["bot1", "bot2", "bot3"] });
    }
    all(bots(inGame), "game-started", 0, { rounds: 3, players: mutation === "in-game-started" ? [...inGame, out] : inGame });
    let room = bots(inGame);
    for (let round = 1; round <= 3; round++) {
      if (mutation === "game-stopped" && round === 3) break;
      all(room, "waiting-photo", round, { round, duration: 15000 });
      all(room, "round-start", round, { photo: `/temp/p${round}.jpg`, duration: 7700 });
      at("bot1", "owner-signal", round, { via: "round-start" });
      if (round === 2 && !lobbyKick) {
        if (scenario === "left") { at("bot3", "left-room", 2); room = ["bot1", "bot2"]; }
        else {
          at("bot1", "kick-sent", 2, { username: out });
          if (mutation !== "no-notice") all(bots(inGame), "player-removed", 2, { username: out });
          if (out === "bot3" && mutation !== "still-connected") at("bot3", "kicked-out", 2, { reason: "io server disconnect" });
          if (mutation === "events-after-kick") at("bot3", "round-reveal", 2, { correctAnswer: "bot1" });
          room = bots(inGame).filter((n) => n !== out);
        }
        if (scenario === "left" && mutation !== "no-notice") all(room, "player-left", 2, { username: "bot3" });
      }
      const answer = mutation === "answer-after-exit" && round === 3 ? out : "bot1";
      all(room, "guess-sent", round, (n) => ({ guess: n === "bot1" ? "" : mutation === "guess-after-exit" && round === 3 ? out : "bot1" }));
      all(room, "round-reveal", round, { correctAnswer: answer });
      const rows = [...room, ...(mutation === "scores-after-exit" && round === 3 ? [out] : [])];
      all(room, "round-scores", round, { round, scores: rows.map((u) => ({ username: u, points: 0, lastGuess: u === "bot1" ? "" : mutation === "guess-after-exit" && round === 3 ? out : "bot1" })) });
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
expect_clean "a bot kicked at round 2: told, cut off, game goes on" kicked
expect_clean "a device kicked at round 2 (bots only see the notice)" kicked-device
expect_clean "a bot kicked in the lobby: not in the game" lobby-kick
expect_error "leave: a stayer never told (player-left)" left no-notice "bot1: never got player-left for bot3"
expect_error "kick: a stayer never told (player-removed)" kicked no-notice "bot2: never got player-removed for bot3"
expect_error "leave: still in a later round-scores" left scores-after-exit "bot1: bot3 left but is still in round-scores"
expect_error "kick: someone guessed the removed player" kicked guess-after-exit "bot2: guessed bot3 after it was removed"
expect_error "leave: the answer of a later round is the leaver" left answer-after-exit "round 3: the answer is bot3, who left in round 2"
expect_error "leave: no round after the leave" left game-stopped "bot1: no round after round 2, when bot3 left"
expect_error "kick: the kicked bot stays connected" kicked still-connected "bot3: still connected after being kicked"
expect_error "kick: the kicked bot gets game events afterwards" kicked events-after-kick "bot3: got round-reveal after being kicked"
expect_error "lobby kick: the kicked bot is in game-started" lobby-kick in-game-started "bot1: bot3 was removed but is in game-started"
expect_error "lobby kick: the kicked bot gets game-started" lobby-kick events-after-kick "bot3: got game-started after being kicked"
expect_error "leave: an event missed before the exit is still a missed event" left missed-before-exit "missed events: bot3"
got="$(exits left missed-before-exit)"
[[ "$got" == "missed events: bot3 [round-reveal#1]" ]] && ok "leave: only that one is reported (none of the rounds after the exit)" || ko "leave: only that one is reported" "$got"

echo "# $pass passed, $fail failed"
[ "$fail" = 0 ]
