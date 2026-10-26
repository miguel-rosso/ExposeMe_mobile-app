// Consistency checks and sync metrics of one bots room (qa/lab/bots.mjs), kept apart from the socket code so they run
// on recorded events too (qa/lab/tests/bots-analysis.test.sh replays anonymised runs from fixtures).
//
// analyseRoom(room, opts) -> the room's entry of the bots summary (`rooms_detail`). Each check* function covers one
// scenario and returns its consistency errors; the order of the checks is the order of `consistency_errors`.
import { percentile } from "./stats.mjs";

// ── Limits the checks use ──
const UNAVAILABLE_SKIP_MAX_MS = 2_000; // photo-unavailable → round-skipped must be immediate (the wait is 15 s)
// A second game whose players all sent im-ready starts its first round ~1 s after game-started; the ready timeout is 10 s
const NEXT_GAME_READY_MAX_MS = 8_000;
const DISCONNECT_GRACE_MS = 15_000; // server: a player disconnected this long is gone (lobby shows it, host hands over)
const NEW_HOST_EARLY_SLACK_MS = 1_000; // a new-host this much before the grace runs out is still on time
// Pause limits, as in Server/managers/GameEngine.ts (GAME_FLOW.md "Pause limit"; bots-cli.test.sh checks the copies)
const MAX_PAUSES = 3; // counted pauses per game
const MAX_TOTAL_PAUSES = 10; // pauses per game, counted or refunded
const PAUSE_GRACE_MS = 10_000; // a pause resumed sooner is refunded (not counted)
const GRACE_SLACK_MS = 500; // near PAUSE_GRACE_MS, network latency decides: accept both

// Phase events every player receives (keyed by round), and the events that ended a bot's stay in the room
const SYNCED_EVENTS = ["round-start", "round-reveal", "round-scores", "game-over", "game-started"];
const OFFLINE_EVENTS = ["chaos-disconnect", "planned-disconnect"];
// Game events a removed player must no longer receive
const GAME_EVENTS = ["game-started", "waiting-photo", "your-turn", "round-start", "round-reveal", "round-scores", "game-state"];

/**
 * @typedef {{ host: boolean, rounds: number, playAgainLingerS: number, lingerBot: number, startNextGameS: number }} AnalysisOpts
 *   the run's options: --host, --rounds, --play-again-linger, --play-again-linger-bot (0-based, -1 = a device lingers),
 *   --start-next-game
 */

// ── Helpers ──
const isWaitKey = (k) => k.startsWith("waiting-photo#");
/** Spread (ms) between the first and the last receipt of the same event. */
const tSpan = (events) => Math.max(...events.map((e) => e.t)) - Math.min(...events.map((e) => e.t));
/** { p50, [p95,] max } of `values` as fixed-point strings (p* undefined and max null when there are none). */
function spread(values, ps = [50], digits = 1) {
  const out = {};
  for (const p of ps) out[`p${p}`] = percentile(values, p)?.toFixed(digits);
  out.max = values.length ? Math.max(...values).toFixed(digits) : null;
  return out;
}
/** Times the busiest player received `ev` (a room-wide event counted once). */
const perBotMax = (r, ev) => Math.max(0, ...r.players.map((n) => r.events.filter((e) => e.bot === n && e.ev === ev).length));
const countOf = (r, evs) => r.events.filter((e) => evs.includes(e.ev)).length;

/** Players out of the room for good (EXP-139): left (--leave-round) or removed by the host (--kick) -> when (ms). */
function exitTimes(r) {
  const at = new Map();
  for (const e of r.events) {
    const who = e.ev === "left-room" ? e.bot : e.ev === "kick-sent" ? e.payload.username : null;
    if (who !== null && !at.has(who)) at.set(who, e.t);
  }
  return at;
}

/** What several checks share: round-starts / reveals, who went offline or out of the room, each round's revealed answer. */
function roomContext(r) {
  const starts = r.events.filter((e) => e.ev === "round-start");
  const reveals = r.events.filter((e) => e.ev === "round-reveal");
  return {
    starts,
    reveals,
    wentOffline: new Set(r.events.filter((e) => OFFLINE_EVENTS.includes(e.ev)).map((e) => e.bot)),
    exitedAt: exitTimes(r),
    answerOf: new Map(reveals.map((rv) => [rv.round, rv.payload.correctAnswer])),
    roundsSeen: [...new Set(starts.map((s) => s.round))].sort((a, b) => a - b),
  };
}

// ── Sync: the same phase event, received by every player, with the same payload ──
/**
 * Groups the phase events per key: `<event>#<round>`, and for waiting-photo (which repeats with the same round number
 * after a skip) each bot's n-th one (same n = same wait). Bots that went offline may have missed one, so they are left
 * out of the waiting-photo alignment.
 */
function phaseGroups(r, ctx) {
  const byKey = new Map();
  const add = (k, e) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); };
  for (const e of r.events) if (SYNCED_EVENTS.includes(e.ev)) add(`${e.ev}#${e.round}`, e);
  const waitSeen = {};
  for (const e of r.events.filter((x) => x.ev === "waiting-photo")) {
    if (ctx.wentOffline.has(e.bot)) continue;
    add(`waiting-photo#${(waitSeen[e.bot] = (waitSeen[e.bot] || 0) + 1)}`, e);
  }
  return byKey;
}

/** Skews (ms) per group, the groups each player never received, and groups whose payloads differ. */
function phaseSync(r, ctx) {
  const byKey = phaseGroups(r, ctx);
  const skews = [], missed = {}, errors = [];
  for (const [k, es] of byKey) {
    const firstAt = Math.min(...es.map((e) => e.t));
    for (const name of r.players) {
      // Bots that went offline are left out of the waiting-photo alignment, so those keys are not "missed" by them;
      // a player out of the room misses what came after its exit on purpose
      if (isWaitKey(k) && ctx.wentOffline.has(name)) continue;
      if (firstAt > (ctx.exitedAt.get(name) ?? Infinity)) continue;
      if (!es.some((e) => e.bot === name)) (missed[name] ||= []).push(k);
    }
    if (es.length > 1) skews.push(tSpan(es));
    const sig = (e) => JSON.stringify(e.payload ?? null);
    if (new Set(es.map(sig)).size > 1) errors.push(`${k}: players received different payloads`);
  }
  const waitSkews = [...byKey].filter(([k, es]) => isWaitKey(k) && es.length > 1).map(([, es]) => tSpan(es));
  return { skews, waitSkews, missed, errors };
}

// ── Checks ──
/** The hosted game must use the requested --rounds (a server without ALLOW_QA_ROUNDS=1 ignores set-rounds 3). */
function checkRequestedRounds(r, opts) {
  if (!opts.host) return [];
  const gs = r.events.find((e) => e.ev === "game-started");
  if (!gs || gs.payload?.rounds === opts.rounds) return [];
  return [`game-started with ${gs.payload?.rounds} rounds, asked for ${opts.rounds}${opts.rounds === 3 ? " (3 needs ALLOW_QA_ROUNDS=1 on the server)" : ""}`];
}

/** waiting-photo is room-wide: { round, duration } only, so the owner stays secret. */
function checkWaitingPhotoPayloads(r) {
  const out = [];
  for (const e of r.events.filter((x) => x.ev === "waiting-photo")) {
    const keys = Object.keys(e.payload || {}).sort().join(",");
    if (keys !== "duration,round") out.push(`${e.bot}: waiting-photo payload has keys [${keys}] (owner must stay secret)`);
  }
  return out;
}

/** photo-unavailable: the reporter gets round-skipped (reason "unavailable") right away, not after the 15 s wait. */
function photoUnavailableSkips(r) {
  const errors = [], skipMs = [];
  for (const rep of r.events.filter((e) => e.ev === "photo-unavailable-sent")) {
    const sk = r.events.find((e) => e.bot === rep.bot && e.ev === "round-skipped" && e.t >= rep.t);
    // A game-paused within the skip window and before the skip: the report reached a paused game, which ignores it
    // (EXP-113); the resume re-sends the same your-turn and only a new report (paired on its own) may skip the round.
    // A later pause excuses nothing: the skip should already have come
    const pausedFirst = r.events.some((e) => e.bot === rep.bot && e.ev === "game-paused" && e.t >= rep.t
      && e.t <= rep.t + UNAVAILABLE_SKIP_MAX_MS && (!sk || e.t <= sk.t));
    if (pausedFirst) continue;
    if (!sk) { errors.push(`${rep.bot}: photo-unavailable (round ${rep.round}) never skipped`); continue; }
    skipMs.push(sk.t - rep.t);
    if (sk.payload?.reason !== "unavailable") errors.push(`${rep.bot}: photo-unavailable skipped with reason ${sk.payload?.reason}`);
    if (sk.t - rep.t > UNAVAILABLE_SKIP_MAX_MS) errors.push(`${rep.bot}: photo-unavailable took ${Math.round(sk.t - rep.t)}ms to skip`);
  }
  return { errors, skipMs };
}

/**
 * The photo owner plays like everyone (EXP-252): every round-scores row, the owner's included, is correct exactly
 * when its guess is the revealed answer (voting for yourself counts). Nobody is told isOwner any more: payloadLeaks
 * in bots.mjs reports such a key.
 */
function checkScoredLikeEveryone(r, ctx) {
  const out = [];
  for (const [round, answer] of ctx.answerOf) {
    const sc = r.events.find((e) => e.ev === "round-scores" && e.round === round);
    for (const row of sc?.payload?.scores ?? []) {
      const correct = !!row.lastGuess && row.lastGuess === answer;
      if (!!row.lastAnswerCorrect !== correct) out.push(`round ${round}: ${row.username}${row.username === answer ? " (owner)" : ""} guessed "${row.lastGuess ?? ""}" but was scored ${row.lastAnswerCorrect ? "correct" : "wrong"}`);
    }
  }
  return out;
}

/**
 * Answers freeze when answering ends (EXP-148): each bot's lastGuess in round-scores is its last pick sent while
 * answering ("" if none); a late-submit (the revealed answer, sent at round-reveal) never counts.
 */
function checkFrozenAnswers(r, ctx) {
  const out = [];
  const scoredRounds = new Map();
  for (const e of r.events.filter((x) => x.ev === "round-scores")) if (!scoredRounds.has(e.round)) scoredRounds.set(e.round, e);
  for (const [round, sc] of scoredRounds) {
    for (const row of sc.payload?.scores ?? []) {
      if (ctx.wentOffline.has(row.username) || !r.players.includes(row.username)) continue;
      const sent = r.events.filter((e) => e.bot === row.username && e.ev === "guess-sent" && e.round === round && e.t <= sc.t).pop();
      const expected = sent?.payload.guess ?? "";
      const late = r.events.some((e) => e.bot === row.username && e.ev === "late-submit" && e.round === round);
      if (row.lastGuess !== expected) out.push(`round ${round}: ${row.username} scored with "${row.lastGuess}" but its last pick while answering was "${expected}"${late ? " (a vote sent during the reveal counted)" : ""}`);
    }
  }
  return out;
}

/** No double rounds: a player never gets two round-starts for the same round number. */
function checkDuplicateRoundStarts(ctx) {
  const startKeys = ctx.starts.map((s) => `${s.bot}#${s.round}`);
  const dupes = [...new Set(startKeys.filter((k, i) => startKeys.indexOf(k) !== i))];
  return dupes.length ? [`duplicate round-start: ${dupes.join(", ")}`] : [];
}

/**
 * Planted rounds look like any other (EXP-126): each round-start follows a waiting-photo for that round (or a rejoin
 * snapshot of it), whoever planted it. Bots that went offline may have missed the wait, so they are left out.
 */
function checkWaitBeforeRoundStart(r, ctx) {
  const out = [];
  for (const s of ctx.starts) {
    if (ctx.wentOffline.has(s.bot)) continue;
    const before = r.events.filter((e) => e.bot === s.bot && e.t <= s.t && e !== s
      && ["waiting-photo", "round-start", "round-skipped", "game-state"].includes(e.ev)).pop();
    const ok = before && ((before.ev === "waiting-photo" && before.round === s.round)
      || (before.ev === "game-state" && before.payload?.phase === "waiting-photo"));
    if (!ok) out.push(`${s.bot}: round-start for round ${s.round} without a preceding waiting-photo`);
  }
  return out;
}

/** Planted rounds: the revealed owner never got your-turn for that round. */
const plantedRounds = (r, ctx) => [...ctx.answerOf].filter(([round, answer]) =>
  !r.events.some((e) => e.ev === "your-turn" && e.bot === answer && e.round === round)).map(([round]) => round);

/** Payload privacy: no socket ids, other players' tokens or planted photo URLs; guesses hidden until round-scores. */
const checkPayloadLeaks = (r) => r.events.filter((x) => x.ev === "payload-leak").map((e) => `${e.bot}: ${e.payload.leak}`);

/**
 * 2 players, planned drops in time order: each one pauses the game for the other bot and the return resumes it, until
 * the pauses are used up (GAME_FLOW.md "Pause limit"): the drop that would need a 4th counted pause or an 11th in all
 * ends the game at once (game-over, no game-paused). A pause shorter than PAUSE_GRACE_MS is refunded (not counted).
 */
function twoPlayerDropErrors(r, drops) {
  const out = [];
  let counted = 0, total = 0;
  for (const [n, d] of drops.entries()) {
    const other = r.players.find((p) => p !== d.bot);
    const nextDropAt = drops[n + 1]?.t ?? Infinity;
    const otherGot = (ev) => r.events.find((e) => e.bot === other && e.ev === ev && e.t > d.t && e.t < nextDropAt);
    const paused = otherGot("game-paused");
    if (counted >= MAX_PAUSES || total >= MAX_TOTAL_PAUSES) {
      const used = `pauses used up (${counted}/${MAX_PAUSES} counted, ${total}/${MAX_TOTAL_PAUSES} in all)`;
      if (paused) out.push(`round ${d.round} drop: ${used} but ${other} got game-paused ${paused.payload.pause}/${paused.payload.maxPauses}`);
      if (!otherGot("game-over")) out.push(`round ${d.round} drop: ${used} but the game did not end for ${other}`);
      break; // the game is over: no later drop can happen
    }
    if (!paused) { out.push(`2 players: ${other} never got game-paused`); continue; }
    const resumed = otherGot("game-resumed");
    if (!resumed) { out.push(`2 players: ${other} never got game-resumed`); continue; }
    total++;
    if (resumed.t - paused.t >= PAUSE_GRACE_MS) counted++;
  }
  return out;
}

/** Planned drop: the bot must come back with a snapshot; with 2 players the game must pause and resume. */
function checkPlannedDrops(r) {
  const out = [];
  const drops = r.events.filter((e) => e.ev === "planned-disconnect");
  for (const d of drops) {
    if (!r.events.some((e) => e.bot === d.bot && e.ev === "game-state" && e.t > d.t)) out.push(`${d.bot} rejoined without a game-state snapshot`);
    // --drop-on-turn (EXP-226): the returning owner still sends the awaited photo, and its round is not timed out
    if (d.payload?.onTurn) {
      const after = (ev) => r.events.filter((e) => e.ev === ev && e.round === d.round && e.t > d.t);
      const sent = after("photo-sent").some((e) => e.bot === d.bot && e.payload?.attempt === d.payload.attempt);
      if (!sent) out.push(`${d.bot}: never sent its round ${d.round} photo (attempt ${d.payload.attempt}) after returning`);
      if (after("round-skipped").some((e) => e.payload?.reason === "timeout")) out.push(`round ${d.round} skipped by timeout after its owner ${d.bot} returned`);
    }
  }
  if (r.players.length === 2) out.push(...twoPlayerDropErrors(r, drops));
  return out;
}

/**
 * Dropped turns: a connected bot drops a turn only because its request ended; the server must then ask again for
 * that round (a later your-turn) or skip it for a reason other than the 15 s timeout, or the photo was lost.
 */
function checkDroppedTurns(r) {
  const out = [];
  for (const e of r.events.filter((x) => x.ev === "turn-dropped" && x.payload?.connected)) {
    const { attempt, turnAt } = e.payload;
    const askedAgain = r.events.some((x) => x.ev === "your-turn" && x.bot === e.bot && x.round === e.round && x.t > turnAt);
    const skippedOtherwise = r.events.some((x) => x.ev === "round-skipped" && x.bot === e.bot && x.round === e.round
      && x.t > turnAt && x.payload?.reason !== "timeout");
    if (!askedAgain && !skippedOtherwise) out.push(`${e.bot}: dropped its round ${e.round} turn (attempt ${attempt}) and was never asked again`);
  }
  return out;
}

/**
 * Pause N of M: every game-paused says which pause it is (the would-be number), never beyond the cap. Re-sends within
 * one pause keep the number; the next pause repeats it if the last one was refunded (resumed within PAUSE_GRACE = 10 s)
 * and is one more if it counted. Never going back. Also returns the highest pause number each bot saw last.
 */
function pauseNumbers(r) {
  const errors = [];
  const lastPause = {};
  const pauseState = {}; // bot -> { number, startedAt, resumedAt }
  for (const e of r.events.filter((x) => x.ev === "game-paused" || x.ev === "game-resumed")) {
    const st = pauseState[e.bot] || (pauseState[e.bot] = { number: 0, startedAt: null, resumedAt: null });
    if (e.ev === "game-resumed") { if (st.startedAt !== null && st.resumedAt === null) st.resumedAt = e.t; continue; }
    const { pause, maxPauses } = e.payload;
    if (!Number.isInteger(pause) || !Number.isInteger(maxPauses) || pause < 1 || pause > maxPauses) { errors.push(`${e.bot}: bad game-paused pause ${pause}/${maxPauses}`); continue; }
    const samePause = st.startedAt !== null && st.resumedAt === null;
    if (samePause) {
      if (pause !== st.number) errors.push(`${e.bot}: pause number changed within one pause ${st.number} -> ${pause}`);
    } else if (st.startedAt !== null) {
      const lasted = st.resumedAt - st.startedAt;
      const allowed = lasted < PAUSE_GRACE_MS - GRACE_SLACK_MS ? [st.number]
        : lasted > PAUSE_GRACE_MS + GRACE_SLACK_MS ? [st.number + 1] : [st.number, st.number + 1];
      if (pause < st.number) errors.push(`${e.bot}: pause number went back ${st.number} -> ${pause}`);
      else if (!allowed.includes(pause)) errors.push(`${e.bot}: pause ${st.number} lasted ${lasted}ms, next pause should be ${allowed.join(" or ")}, got ${pause}`);
    }
    if (!samePause) Object.assign(st, { number: pause, startedAt: e.t, resumedAt: null });
    lastPause[e.bot] = pause;
  }
  return { errors, maxPauseNumber: Math.max(0, ...Object.values(lastPause)) };
}

/**
 * Lobby host drop (EXP-157): after the grace, not before, the others see the host gone and get a new host who can
 * start; the old host is not in the game.
 */
function checkLobbyHostDrop(r) {
  const hostDrop = r.events.find((e) => e.ev === "lobby-host-drop");
  if (!hostDrop) return [];
  const out = [];
  for (const n of r.players.filter((p) => p !== hostDrop.bot)) {
    const gone = r.events.find((e) => e.bot === n && e.ev === "player-connection" && e.payload.username === hostDrop.bot && e.payload.connected === false);
    const nh = r.events.find((e) => e.bot === n && e.ev === "new-host");
    if (!gone) out.push(`${n}: never got player-connection { ${hostDrop.bot}, connected: false }`);
    if (!nh) { out.push(`${n}: never got new-host after the host dropped`); continue; }
    if (nh.payload.username === hostDrop.bot) out.push(`${n}: new-host named the dropped host`);
    if (nh.t - hostDrop.t < DISCONNECT_GRACE_MS - NEW_HOST_EARLY_SLACK_MS) out.push(`${n}: new-host ${Math.round(nh.t - hostDrop.t)}ms after the drop (grace is ${DISCONNECT_GRACE_MS}ms)`);
    if (!r.events.find((e) => e.bot === n && e.ev === "game-started")) out.push(`${n}: the new host never started the game`);
  }
  if (r.events.some((e) => e.bot === hostDrop.bot && e.ev === "game-started")) out.push(`${hostDrop.bot}: dropped host got game-started`);
  return out;
}

/** Play again after lingering (EXP-172): nobody went offline at game-over, so nobody is shown gone nor loses the host role. */
function checkPlayAgainJoins(r, opts) {
  const out = [];
  // Second-game events count too ("g2-" prefix)
  const evName = (e) => e.ev.replace(/^g2-/, "");
  for (const n of r.players) {
    const over = r.events.find((e) => e.bot === n && e.ev === "game-over");
    if (!over) continue;
    for (const e of r.events.filter((x) => x.bot === n && x.t > over.t)) {
      if (evName(e) === "player-connection" && e.payload.connected === false) out.push(`${n}: saw ${e.payload.username} gone after game-over`);
      if (evName(e) === "new-host") out.push(`${n}: new-host ${e.payload.username} after game-over`);
    }
    const pa = r.events.find((e) => e.bot === n && evName(e) === "play-again-joined");
    if (!pa) { out.push(`${n}: Play again join never answered`); continue; }
    if (!pa.payload.sameToken) out.push(`${n}: Play again join changed the rejoin token`);
    if (pa.payload.gone.length) out.push(`${n}: Play again lobby shows gone: ${pa.payload.gone.join(", ")}`);
    if (n === r.players[0] && opts.host && !pa.payload.isHost) out.push(`${n}: host lost the role after lingering`);
  }
  return out;
}

/**
 * A next game started while someone (bot K, or a device with --start-next-game) was still on the final screens: that
 * player is taken into it at once (EXP-184, DEC-018 A), so its ready phase never waits for the ready timeout and no
 * round is skipped by the 15 s photo timeout.
 */
function checkSecondGame(r, opts) {
  const lingerer = r.players[opts.lingerBot];
  if (!((opts.lingerBot > 0 && lingerer) || (opts.lingerBot < 0 && opts.startNextGameS))) return [];
  const out = [];
  const who = lingerer ?? "the lingering device";
  for (const n of r.players) {
    const g2Start = r.events.find((e) => e.bot === n && (e.ev === "g2-game-started" || e.ev === "g2-game-started-while-lingering"));
    if (!g2Start) { out.push(`${n}: the second game never started`); continue; }
    const firstWait = r.events.find((e) => e.bot === n && e.ev === "g2-waiting-photo");
    if (!firstWait) out.push(`${n}: the second game never asked for a photo`);
    else if (firstWait.t - g2Start.t > NEXT_GAME_READY_MAX_MS) {
      out.push(`${n}: second game's first round came ${Math.round(firstWait.t - g2Start.t)} ms after game-started (ready timeout: ${who} never sent im-ready)`);
    }
    if (!r.events.some((e) => e.bot === n && e.ev === "g2-game-over")) out.push(`${n}: the second game never ended`);
  }
  for (const e of r.events.filter((x) => x.ev === "g2-round-skipped" && x.payload?.reason === "timeout")) {
    out.push(`${e.bot}: second game round ${e.round} skipped by timeout (${who} kept it waiting)`);
  }
  return out;
}

/** The bot K that lingered (--play-again-linger-bot K > 1) joined the second game from its final screens and played it. */
function checkLingeringBot(r, opts) {
  const lingerer = r.players[opts.lingerBot];
  if (!(opts.lingerBot > 0 && lingerer)) return [];
  const out = [];
  if (!r.events.some((e) => e.ev === "g2-game-started-while-lingering" && e.bot === lingerer)) out.push(`${lingerer}: the second game never started while it lingered`);
  const pa = r.events.find((e) => e.bot === lingerer && e.ev === "g2-play-again-joined");
  if (pa && !pa.payload.started) out.push(`${lingerer}: its join from the final screens did not land in the started game`);
  if (r.events.some((e) => e.bot === lingerer && e.ev === "g2-linger-photo-unavailable")) out.push(`${lingerer}: declined a turn from the final screens instead of joining the game`);
  // Played every round of the second game like the others (it saw each round-start and guessed, its own photos too)
  const g2Rounds = (n) => new Set(r.events.filter((e) => e.bot === n && e.ev === "g2-round-start").map((e) => e.round));
  const host = r.players.find((n) => n !== lingerer);
  const missed = [...g2Rounds(host)].filter((rd) => !g2Rounds(lingerer).has(rd));
  if (missed.length) out.push(`${lingerer}: missed second game rounds ${missed.join(", ")}`);
  if (g2Rounds(lingerer).size && !r.events.some((e) => e.bot === lingerer && e.ev === "g2-guess-sent")) out.push(`${lingerer}: never answered in the second game`);
  return out;
}

const checkPlayAgain = (r, opts) => (opts.playAgainLingerS
  ? [...checkPlayAgainJoins(r, opts), ...checkSecondGame(r, opts), ...checkLingeringBot(r, opts)] : []);

/**
 * Players out of the room (EXP-139): a bot that left (--leave-round, "left-room") or a player the host removed
 * (--kick, "kick-sent"). Every other bot still in the room (not offline meanwhile) is told (player-left /
 * player-removed); from then on the player is in no player list, score table or answer, and nobody guesses it; a
 * mid-game exit doesn't stop the game while 2 players remain. A kicked bot gets player-removed itself, then the server
 * closes its connection ("kicked-out") and it gets no more game events.
 */
function checkRoomExits(r, ctx) {
  const exits = r.events.filter((e) => e.ev === "left-room" || e.ev === "kick-sent")
    .map((e) => e.ev === "left-room"
      ? { who: e.bot, round: e.round, t: e.t, notice: "player-left", how: "left" }
      : { who: e.payload.username, round: e.round, t: e.t, notice: "player-removed", how: "was removed" });
  if (!exits.length) return [];
  const out = [];
  const gameRounds = r.events.find((e) => e.ev === "game-started")?.payload?.rounds ?? 0;
  const stayers = r.players.filter((n) => !ctx.exitedAt.has(n) && !ctx.wentOffline.has(n));
  for (const x of exits) {
    for (const n of stayers) {
      const told = r.events.find((e) => e.bot === n && e.ev === x.notice && e.payload?.username === x.who && e.t >= x.t);
      if (!told) { out.push(`${n}: never got ${x.notice} for ${x.who}`); continue; }
      const later = r.events.filter((e) => e.bot === n && e.t > told.t);
      if (later.some((e) => e.ev === "game-started" && e.payload?.players?.includes(x.who))) out.push(`${n}: ${x.who} ${x.how} but is in game-started`);
      if (later.some((e) => e.ev === "round-scores" && e.payload?.scores?.some((s) => s.username === x.who))) out.push(`${n}: ${x.who} ${x.how} but is still in round-scores`);
      if (later.some((e) => e.ev === "guess-sent" && e.payload?.guess === x.who)) out.push(`${n}: guessed ${x.who} after it ${x.how}`);
      // The game goes on for the others (a round after the exit's) while the room still has 2 players to play
      const playersLeft = r.events.find((e) => e.ev === "round-scores" && e.t > told.t)?.payload?.scores?.length ?? 0;
      if (x.round >= 1 && x.round < gameRounds && playersLeft >= 2 && !later.some((e) => e.ev === "round-start" && e.round > x.round)) {
        out.push(`${n}: no round after round ${x.round}, when ${x.who} ${x.how}`);
      }
    }
    for (const [round, answer] of ctx.answerOf) if (answer === x.who && round > x.round) out.push(`round ${round}: the answer is ${x.who}, who ${x.how} in round ${x.round}`);
    if (x.notice === "player-removed" && r.players.includes(x.who)) out.push(...checkKickedBot(r, x.who));
  }
  return out;
}

/** A kicked bot: told first (player-removed naming itself), then its connection closed by the server, nothing after. */
function checkKickedBot(r, name) {
  const removed = r.events.find((e) => e.bot === name && e.ev === "player-removed" && e.payload?.username === name);
  if (!removed) return [`${name}: kicked without getting player-removed`];
  const out = [];
  if (!r.events.some((e) => e.bot === name && e.ev === "kicked-out" && e.t >= removed.t)) out.push(`${name}: still connected after being kicked`);
  const after = r.events.filter((e) => e.bot === name && e.t > removed.t && GAME_EVENTS.includes(e.ev)).map((e) => e.ev);
  if (after.length) out.push(`${name}: got ${[...new Set(after)].join(", ")} after being kicked`);
  return out;
}

/** Round numbers run 1, 2, 3… with no gap. */
const checkRoundNumbering = (ctx) => ctx.roundsSeen.flatMap((n, i) => (n !== i + 1 ? [`round numbering gap: expected ${i + 1}, got ${n}`] : []));

/** How much later than its duration each round-start's answering phase ended (round-reveal), per bot and round. */
function answerPhaseOverruns(ctx) {
  const gaps = [];
  for (const s of ctx.starts) {
    const rv = ctx.reveals.find((x) => x.bot === s.bot && x.round === s.round);
    if (rv) gaps.push(rv.t - s.t - s.payload.duration);
  }
  return gaps;
}

/** Second game (started while someone lingered on the final screens, EXP-184): ms from game-started to its first wait. */
function secondGameReadyMs(r) {
  const g2s = r.events.find((e) => e.ev === "g2-game-started" || e.ev === "g2-game-started-while-lingering");
  const w = g2s && r.events.find((e) => e.bot === g2s.bot && e.ev === "g2-waiting-photo");
  return w ? Math.round(w.t - g2s.t) : null;
}

// ── Room summary ──
/**
 * `r`: { code, reason, players, errors, uploads, rateLimited, events } of one room (bots.mjs runRoom).
 * @param {AnalysisOpts} opts
 */
export function analyseRoom(r, opts) {
  const ctx = roomContext(r);
  const sync = phaseSync(r, ctx);
  const unavailable = photoUnavailableSkips(r);
  const pauses = pauseNumbers(r);
  const consistency = [
    ...checkRequestedRounds(r, opts),
    ...checkWaitingPhotoPayloads(r),
    ...unavailable.errors,
    ...sync.errors,
    ...checkScoredLikeEveryone(r, ctx),
    ...checkFrozenAnswers(r, ctx),
    ...checkDuplicateRoundStarts(ctx),
    ...checkWaitBeforeRoundStart(r, ctx),
    ...checkPayloadLeaks(r),
    ...checkPlannedDrops(r),
    ...checkDroppedTurns(r),
    ...pauses.errors,
    ...checkLobbyHostDrop(r),
    ...checkPlayAgain(r, opts),
    ...checkRoomExits(r, ctx),
    ...checkRoundNumbering(ctx),
  ];
  return {
    code: r.code,
    reason: r.reason,
    players: r.players.length,
    rounds_played: ctx.roundsSeen.length,
    rounds_skipped: perBotMax(r, "round-skipped"),
    planted_sent: countOf(r, ["planted"]),
    planted_rounds: plantedRounds(r, ctx),
    skipped_unavailable: countOf(r, ["photo-unavailable-sent"]),
    unavailable_skip_ms: spread(unavailable.skipMs),
    waiting_photo: perBotMax(r, "waiting-photo"),
    waiting_photo_skew_ms: spread(sync.waitSkews),
    disconnects: countOf(r, OFFLINE_EVENTS),
    resyncs: countOf(r, ["game-state"]),
    pauses: perBotMax(r, "game-paused"),
    max_pause_number: pauses.maxPauseNumber,
    resumes: perBotMax(r, "game-resumed"),
    linger_turns_reported: countOf(r, ["g2-linger-photo-unavailable"]),
    // Second game (started while someone lingered on the final screens, EXP-184): rounds played and ready-phase length
    second_game_rounds: new Set(r.events.filter((e) => e.ev === "g2-round-start").map((e) => e.round)).size,
    second_game_ready_ms: secondGameReadyMs(r),
    skew_ms: spread(sync.skews, [50, 95]),
    answer_phase_overrun_ms: spread(answerPhaseOverruns(ctx)),
    upload_ms: spread(r.uploads, [50], 0),
    uploads_rate_limited: r.rateLimited,
    missed_events: sync.missed, // phase events a player never received while offline (game-state resyncs them)
    consistency_errors: consistency,
    errors: r.errors,
  };
}
