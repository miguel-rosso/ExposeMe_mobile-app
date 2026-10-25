#!/usr/bin/env node
// Headless ExposeMe players. They speak the same socket protocol as the app
// (see Server/GAME_FLOW.md), so they can fill a room next to real devices,
// load-test the server, and measure sync: how far apart each player receives
// the same phase event, and whether every player saw the same game.
//
//   node qa/lab/bots.mjs --bots 4 --host --rounds 10 --wait-players 6 --code-file /tmp/code
//   node qa/lab/bots.mjs --bots 3 --code 123456          # join an existing room
//   node qa/lab/bots.mjs --rooms 20 --bots 4 --host       # load: 20 parallel rooms
//   options: --server URL  --photos DIR  --out FILE  --chaos 0.1  --upload-fail 0.2  --timeout 600
//            --no-ready K   the last K bots never send im-ready (game must start via the server's ready timeout)
//            --no-answer    bots always submit an empty guess (everyone ends on 0 points: final tie, see qa/maestro/tie-game.yaml)
//            --drop-round R --drop-secs S [--drop-bot K]
//                           bot K (1-based, default the last one) drops at round R's round-start and reconnects
//                           S seconds later (rejoin + game-state snapshot). With --bots 2 the game must pause
//                           (game-paused) and resume (game-resumed) for the other bot. Each pause carries
//                           pause N of maxPauses (3 counted per game, each with a full 5 min countdown; a 4th ends the
//                           game). A pause resumed within 10 s is refunded (the next pause repeats its number); at most
//                           10 pauses in all per game.
//   node qa/lab/bots.mjs --bots 3 --host --drop-round 2 --drop-secs 3     # drop mid-round, game goes on
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8     # 2 players: pause → resume
//            --app-resync   after a rejoin snapshot of a started game, ignore it (and your-turn) and re-send the join
//                           on the same socket, like the app going from its lobby to the game screen (EXP-097)
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8 --app-resync
//            --photo-unavailable P   on its turn a bot reports photo-unavailable { round, attempt } with probability P (like a phone with no
//                           gallery access / no photos / failed uploads): the round must be skipped at once for everyone
//                           (round-skipped reason "unavailable"), not after the 15 s wait. --upload-fail P instead stays
//                           silent, so the server skips by timeout (reason "timeout").
//   node qa/lab/bots.mjs --bots 3 --host --photo-unavailable 0.3
//   Every bot records waiting-photo { round, duration } (room-wide, owner secret): same payload for all, skew measured.
//   Photos: uploads send the room code + the bot's rejoin token (X-Game-Code / Authorization: Bearer), like the app;
//   on each round-start one non-owner bot GETs the photo with them (must be 200) and without (must be 401): "photo-access".
//   Payload privacy (EXP-017/EXP-027): every event a bot receives is scanned; no socketId / rejoinToken / plantedPhoto
//   key (except the bot's own token in room-of-game), no socket id or other bot's token as a value; during
//   answering/reveal no player in room-of-game / game-state (players and scores) / new-host / player-removed shows
//   this round's guess or more points than at the last round-scores; a waiting-photo game-state has no owner/photo:
//   "payload-leak".
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
    return acc;
  }, [])
);
const SERVER = args.server || process.env.SERVER_URL || "http://localhost:3000";
const N_BOTS = Number(args.bots || 3);
const N_ROOMS = Number(args.rooms || 1);
const ROUNDS = Number(args.rounds || 10);
const WAIT_PLAYERS = Number(args["wait-players"] || N_BOTS);
const CHAOS = Number(args.chaos || 0);
const UPLOAD_FAIL = Number(args["upload-fail"] || 0);
const PHOTO_UNAVAILABLE = Number(args["photo-unavailable"] || 0);
const UNAVAILABLE_SKIP_MAX_MS = 2_000; // photo-unavailable → round-skipped must be immediate (the wait is 15 s)
const NO_READY = Number(args["no-ready"] || 0);
const NO_ANSWER = !!args["no-answer"];
// --no-answer: bots submit an empty guess like a player who never taps, so nobody scores (tie at 0)
const pickGuess = (bot) => (NO_ANSWER ? "" : bot.players[Math.floor(Math.random() * bot.players.length)] || "");
const TIMEOUT_S = Number(args.timeout || 900);
const DROP_ROUND = Number(args["drop-round"] || 0);
const DROP_SECS = Number(args["drop-secs"] || 5);
const DROP_BOT = Number(args["drop-bot"] || N_BOTS) - 1;
// Like the app rejoining from its lobby screen ("Join" after closing it): the first snapshot of a started game
// (and any your-turn with it) is missed while switching screens, then the join is re-sent on the same socket,
// which answers with a fresh game-state (and your-turn for an awaited photo)
const APP_RESYNC = !!args["app-resync"];
const PHOTOS = args.photos ? fs.readdirSync(args.photos).filter((f) => f.endsWith(".jpg")).map((f) => path.join(args.photos, f)) : [];

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

// /upload and /temp only answer members of the photo's room: room code + the bot's rejoin token (never logged)
const photoAuth = (code, token) => ({ Authorization: `Bearer ${token}`, "X-Game-Code": code });

const PRIVATE_KEYS = new Set(["socketId", "rejoinToken", "plantedPhoto"]);

/**
 * Privacy problems in one received event (EXP-017/EXP-027). `ids`: every socket id the room's bots have had;
 * `tokens`: name -> rejoin token. Messages never include the secret values themselves.
 */
function payloadLeaks(me, ev, payload, ids, tokens, ctx = { phase: null, baseline: null }) {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === "string") {
      if (ids.has(v)) out.push(`${ev} ${p}: a socket id`);
      for (const [name, tok] of tokens) if (tok && v === tok && !(ev === "room-of-game" && p === "0.rejoinToken" && name === me)) out.push(`${ev} ${p}: ${name}'s rejoin token`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}.${i}`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (PRIVATE_KEYS.has(k) && !(ev === "room-of-game" && p === "0" && k === "rejoinToken")) out.push(`${ev} ${p}.${k}: private key`);
        walk(x, `${p}.${k}`);
      }
    }
  };
  payload.forEach((x, i) => walk(x, String(i)));
  // The round's answers (guess, correctness, the point it earned) stay hidden until round-scores
  const inRound = (phase) => phase === "answering" || phase === "reveal";
  const checkHidden = (entries, where, phase) => {
    for (const pl of entries) {
      if (!pl || typeof pl !== "object") continue;
      if (pl.lastGuess || pl.lastAnswerCorrect) out.push(`${where}: ${pl.username}'s guess visible during ${phase}`);
      const before = ctx.baseline?.get(pl.username);
      if (before !== undefined && pl.points > before) out.push(`${where}: ${pl.username}'s points ${before} -> ${pl.points} during ${phase} (before round-scores)`);
    }
  };
  const state = ev === "room-of-game" ? payload[0]?.room : ev === "game-state" ? payload[0] : null;
  if (state?.started && inRound(state.phase)) {
    checkHidden(state.players ?? [], `${ev}.players`, state.phase);
    if (ev === "game-state") checkHidden(state.scores ?? [], "game-state.scores", state.phase);
  }
  // Single-player events while the round is in play (phase as this bot last saw it)
  if ((ev === "new-host" || ev === "player-removed") && inRound(ctx.phase)) checkHidden([payload[0]], ev, ctx.phase);
  // The owner is secret while the photo is awaited
  if (ev === "game-state" && state?.phase === "waiting-photo" && (state.owner != null || state.photo != null)) {
    out.push(`game-state: owner/photo set during waiting-photo`);
  }
  return out;
}

async function uploadPhoto(label, auth) {
  const t0 = now();
  let blob;
  if (PHOTOS.length) blob = new Blob([fs.readFileSync(PHOTOS[Math.floor(Math.random() * PHOTOS.length)])], { type: "image/jpeg" });
  else blob = new Blob([Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64")], { type: "image/jpeg" });
  const form = new FormData();
  form.append("image", blob, `${label}.jpg`);
  const res = await fetch(`${SERVER}/upload`, { method: "POST", body: form, headers: auth });
  if (res.status === 429) throw Object.assign(new Error("upload 429 rate-limited (raise UPLOAD_RATE_MAX on the server)"), { rateLimited: true });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return { url: (await res.json()).url, ms: now() - t0 };
}

function runRoom(roomIdx, fixedCode) {
  return new Promise((resolve) => {
    const prefix = N_ROOMS > 1 ? `r${roomIdx}-` : "";
    const events = []; // {bot, ev, round, t, payload}
    const errors = [];
    const uploads = [];
    let rateLimited = 0; // uploads refused with 429 (server rate limit, not a game bug)
    let code = fixedCode || null;
    let finished = 0;
    let started = false;
    const bots = [];
    const socketIds = new Set(); // every socket id of this room's bots (they change on reconnect)

    const done = (reason) => {
      clearTimeout(timer);
      bots.forEach((b) => b.socket.disconnect());
      resolve({ code, events, errors, uploads, rateLimited, reason, players: bots.map((b) => b.name) });
    };
    const timer = setTimeout(() => { errors.push(`timeout after ${TIMEOUT_S}s`); done("timeout"); }, TIMEOUT_S * 1000);

    const checkPhotoAccess = async (name, photo, auth, round) => {
      try {
        const member = await fetch(`${SERVER}${photo}`, { headers: auth });
        await member.arrayBuffer();
        const anon = await fetch(`${SERVER}${photo}`);
        await anon.arrayBuffer();
        events.push({ bot: name, ev: "photo-access", round, t: now(), payload: { member: member.status, anonymous: anon.status } });
        // 404 for a member is fine only if the game already ended meanwhile (photos are deleted at game-over)
        if (member.status !== 200 && !(member.status === 404 && finished)) errors.push(`${name}: room photo GET ${member.status} (expected 200)`);
        if (anon.status !== 401) errors.push(`${name}: photo GET without credentials ${anon.status} (expected 401)`);
      } catch (e) {
        errors.push(`${name}: photo GET failed: ${e.message}`);
      }
    };

    const makeBot = (i) => {
      const name = `${prefix}bot${i + 1}`;
      const isHost = !!args.host && i === 0;
      const socket = io(SERVER, { transports: ["websocket"], reconnection: true });
      const bot = { name, socket, isHost, players: [], guess: "", round: 0, token: null };
      bots.push(bot);
      const rec = (ev, round, payload) => events.push({ bot: name, ev, round, t: now(), payload });

      // rejoinToken (from our own room-of-game) is required by the server to reconnect with the same username
      const join = () => socket.emit("join-create-game", { gameCode: isHost && !code ? null : code, username: name, ...(bot.token ? { rejoinToken: bot.token } : {}) });
      bot.join = join;
      socket.on("connect", () => {
        socketIds.add(socket.id);
        if (isHost || code) join();
      });
      // Privacy check of every received event. Runs before the event's own handler, so `phase` is the phase this
      // bot was in when it arrived; `baseline` = points per player at the last round-scores (null when unknown)
      const priv = { phase: null, baseline: null };
      socket.on("disconnect", () => { priv.baseline = null; }); // round-scores may be missed while away
      socket.onAny((ev, ...payload) => {
        const tokens = new Map(bots.map((b) => [b.name, b.token]));
        for (const leak of payloadLeaks(name, ev, payload, socketIds, tokens, priv)) rec("payload-leak", bot.round, { leak });
        const d = payload[0];
        if (ev === "game-started") { priv.phase = null; priv.baseline = new Map((d ?? []).map((p) => [p.username, 0])); }
        else if (ev === "waiting-photo") priv.phase = "waiting-photo";
        else if (ev === "round-start") priv.phase = "answering";
        else if (ev === "round-reveal") priv.phase = "reveal";
        else if (ev === "round-scores") { priv.phase = "scores"; priv.baseline = new Map((d?.scores ?? []).map((s) => [s.username, s.points])); }
        else if (ev === "game-resumed" || ev === "hold-resume") priv.phase = d?.phase ?? priv.phase;
        else if (ev === "game-over") priv.phase = null;
        else if (ev === "game-state") {
          priv.phase = d?.started ? d.phase : null;
          if (d?.started) priv.baseline = new Map((d.scores ?? []).map((s) => [s.username, s.points]));
        }
      });
      socket.on("connect_error", (e) => errors.push(`${name} connect_error ${e.message}`));
      socket.on("room-of-game", (d) => {
        if (!d.success) { errors.push(`${name} join failed: ${d.message}`); return; }
        if (d.rejoinToken) bot.token = d.rejoinToken;
        bot.players = d.room.players.map((p) => p.username);
        if (isHost && !code) {
          code = d.room.gameCode;
          if (args["code-file"]) fs.writeFileSync(args["code-file"], code);
          console.log(`[room ${roomIdx}] code ${code}`);
          if ([10, 15, 20].includes(ROUNDS)) socket.emit("set-rounds", { gameCode: code, rounds: ROUNDS });
          bots.filter((b) => !b.isHost).forEach((b) => b.socket.connected && b.join());
        }
        maybeStart();
      });
      socket.on("player-joined", (p) => { bot.players.push(p.username); maybeStart(); });
      socket.on("player-left", (n) => { bot.players = bot.players.filter((x) => x !== n); });
      socket.on("game-started", (players) => {
        bot.players = players.map((p) => p.username);
        rec("game-started", 0);
        if (i >= N_BOTS - NO_READY) { rec("im-ready-skipped-on-purpose", 0); return; }
        socket.emit("im-ready", { gameCode: code, username: name });
      });
      socket.on("your-turn", async (d) => {
        if (bot.resyncing) { rec("your-turn-missed-on-purpose", d.round); return; }
        rec("your-turn", d.round, { attempt: d.attempt });
        if (!Number.isInteger(d.attempt)) errors.push(`${name}: your-turn without an integer attempt`);
        // One report per photo request (a re-sent your-turn of the same attempt doesn't report again)
        if (bot.reportedAttempt !== d.attempt && Math.random() < PHOTO_UNAVAILABLE) {
          bot.reportedAttempt = d.attempt;
          await sleep(100 + Math.random() * 300); // permission check / empty gallery on a phone
          rec("photo-unavailable-sent", d.round, { attempt: d.attempt });
          socket.emit("photo-unavailable", { round: d.round, attempt: d.attempt });
          return;
        }
        if (Math.random() < UPLOAD_FAIL) { rec("upload-skipped-on-purpose", d.round); return; }
        try {
          await sleep(200 + Math.random() * 800); // gallery pick on a phone
          const up = await uploadPhoto(name, photoAuth(code, bot.token));
          uploads.push(up.ms);
          socket.emit("photo-sent", { photo: up.url });
        } catch (e) {
          if (e.rateLimited) rateLimited++;
          errors.push(`${name} upload: ${e.message}`);
        }
      });
      socket.on("round-start", (d) => {
        rec("round-start", d.round, { owner: d.owner, photo: d.photo, duration: d.duration });
        bot.round = d.round;
        bot.guess = pickGuess(bot);
        // Photo access: one non-owner per room loads the photo like the app's <Image> (with credentials), and
        // checks that it is refused without them
        if (name === bots.find((b) => b.name !== d.owner)?.name) checkPhotoAccess(name, d.photo, photoAuth(code, bot.token), d.round);
        if (DROP_ROUND && i === DROP_BOT && d.round === DROP_ROUND && !bot.dropped) {
          bot.dropped = true;
          rec("planned-disconnect", d.round, { secs: DROP_SECS });
          socket.disconnect();
          setTimeout(() => { socket.connect(); }, DROP_SECS * 1000);
          return;
        }
        if (CHAOS && Math.random() < CHAOS) {
          rec("chaos-disconnect", d.round);
          socket.disconnect();
          setTimeout(() => { socket.connect(); }, 1500 + Math.random() * 2000);
        }
      });
      socket.on("round-reveal", (d) => {
        rec("round-reveal", bot.round, { correctAnswer: d.correctAnswer });
        socket.emit("submit-answer", { guess: bot.guess });
      });
      socket.on("round-scores", (d) => rec("round-scores", d.round, { scores: d.scores }));
      socket.on("waiting-photo", (d) => rec("waiting-photo", d.round, d));
      socket.on("round-skipped", (d) => rec("round-skipped", d?.round ?? bot.round, d));
      // Rejoin snapshot: catch up like the app does (guess in reveal, im-ready in the ready phase)
      socket.on("game-state", (d) => {
        rec("game-state", d.round, { phase: d.phase, paused: !!d.pause, pause: d.pause?.pause, maxPauses: d.pause?.maxPauses, started: d.started });
        if (!d.started) return;
        if (APP_RESYNC && !bot.resyncing) {
          bot.resyncing = true;
          rec("app-resync", d.round);
          setTimeout(() => join(), 50); // the game screen takes over the socket
          return;
        }
        bot.resyncing = false;
        bot.players = d.players.map((p) => p.username);
        if (d.round !== bot.round) { bot.round = d.round; bot.guess = pickGuess(bot); }
        if (d.phase === "reveal") socket.emit("submit-answer", { guess: bot.guess });
        if (d.phase === null && i < N_BOTS - NO_READY) socket.emit("im-ready");
      });
      socket.on("game-paused", (d) => {
        rec("game-paused", bot.round, { waitingFor: d.waitingFor, duration: d.duration, pause: d.pause, maxPauses: d.maxPauses });
        console.error(`[room ${roomIdx}] ${name}: game-paused ${d.pause}/${d.maxPauses} (${Math.round(d.duration / 1000)}s), waiting for ${d.waitingFor.join(", ")}`);
      });
      socket.on("game-resumed", (d) => rec("game-resumed", bot.round, { phase: d.phase }));
      socket.on("hold-start", () => rec("hold-start", bot.round));
      socket.on("hold-resume", (d) => rec("hold-resume", bot.round, d));
      socket.on("game-over", (d) => {
        rec("game-over", bot.round, { finalScore: d.finalScore });
        if (++finished === bots.length) done("game-over");
      });
      return bot;
    };

    const maybeStart = () => {
      const host = bots.find((b) => b.isHost);
      if (!host || started || !code) return;
      if (host.players.length >= WAIT_PLAYERS) {
        started = true;
        setTimeout(() => host.socket.emit("start-game", { gameCode: code }), 500);
      }
    };

    for (let i = 0; i < N_BOTS; i++) makeBot(i);
  });
}

/** Times the busiest player received `ev` (a room-wide event counted once). */
const perBotMax = (r, ev) => Math.max(0, ...r.players.map((n) => r.events.filter((e) => e.bot === n && e.ev === ev).length));

function analyse(r) {
  const consistency = [];
  const skews = [];
  const byKey = new Map();
  for (const e of r.events) {
    if (!["round-start", "round-reveal", "round-scores", "game-over", "game-started"].includes(e.ev)) continue;
    const k = `${e.ev}#${e.round}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  // waiting-photo repeats with the same round number after a skip: key each bot's n-th one (same n = same wait)
  // (bots that went offline may have missed one, so they are left out of the alignment)
  const waitSeen = {};
  const wentOffline = new Set(r.events.filter((e) => e.ev === "chaos-disconnect" || e.ev === "planned-disconnect").map((e) => e.bot));
  for (const e of r.events.filter((x) => x.ev === "waiting-photo")) {
    const keys = Object.keys(e.payload || {}).sort().join(",");
    if (keys !== "duration,round") consistency.push(`${e.bot}: waiting-photo payload has keys [${keys}] (owner must stay secret)`);
    if (wentOffline.has(e.bot)) continue;
    const n = (waitSeen[e.bot] = (waitSeen[e.bot] || 0) + 1);
    const k = `waiting-photo#${n}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const waitSkews = [...byKey].filter(([k, es]) => k.startsWith("waiting-photo#") && es.length > 1)
    .map(([, es]) => Math.max(...es.map((e) => e.t)) - Math.min(...es.map((e) => e.t)));
  // photo-unavailable: the reporter gets round-skipped (reason "unavailable") right away, not after the 15 s wait
  const unavailableSkipMs = [];
  for (const rep of r.events.filter((e) => e.ev === "photo-unavailable-sent")) {
    const sk = r.events.find((e) => e.bot === rep.bot && e.ev === "round-skipped" && e.t >= rep.t);
    if (!sk) { consistency.push(`${rep.bot}: photo-unavailable (round ${rep.round}) never skipped`); continue; }
    unavailableSkipMs.push(sk.t - rep.t);
    if (sk.payload?.reason !== "unavailable") consistency.push(`${rep.bot}: photo-unavailable skipped with reason ${sk.payload?.reason}`);
    if (sk.t - rep.t > UNAVAILABLE_SKIP_MAX_MS) consistency.push(`${rep.bot}: photo-unavailable took ${Math.round(sk.t - rep.t)}ms to skip`);
  }
  const missed = {};
  for (const [k, es] of byKey) {
    for (const name of r.players) {
      // Bots that went offline are left out of the waiting-photo alignment, so those keys are not "missed" by them
      if (k.startsWith("waiting-photo#") && wentOffline.has(name)) continue;
      if (!es.some((e) => e.bot === name)) (missed[name] ||= []).push(k);
    }
    if (es.length > 1) skews.push(Math.max(...es.map((e) => e.t)) - Math.min(...es.map((e) => e.t)));
    const sig = (e) => JSON.stringify(e.payload ?? null);
    if (new Set(es.map(sig)).size > 1) consistency.push(`${k}: players received different payloads`);
  }
  const starts = r.events.filter((e) => e.ev === "round-start");
  const reveals = r.events.filter((e) => e.ev === "round-reveal");
  for (const rv of reveals) {
    const st = starts.find((s) => s.bot === rv.bot && s.round === rv.round);
    if (st && st.payload.owner !== rv.payload.correctAnswer) consistency.push(`round ${rv.round}: owner ${st.payload.owner} != reveal ${rv.payload.correctAnswer} (${rv.bot})`);
  }
  // No double rounds: a player never gets two round-starts for the same round number
  const startKeys = starts.map((s) => `${s.bot}#${s.round}`);
  const dupes = [...new Set(startKeys.filter((k, i) => startKeys.indexOf(k) !== i))];
  if (dupes.length) consistency.push(`duplicate round-start: ${dupes.join(", ")}`);
  // Payload privacy: no socket ids, other players' tokens or planted photo URLs; guesses hidden until round-scores
  for (const e of r.events.filter((x) => x.ev === "payload-leak")) consistency.push(`${e.bot}: ${e.payload.leak}`);
  // Planned drop: the bot must come back with a snapshot; with 2 players the game must pause and resume
  const drops = r.events.filter((e) => e.ev === "planned-disconnect");
  for (const d of drops) {
    if (!r.events.some((e) => e.bot === d.bot && e.ev === "game-state" && e.t > d.t)) consistency.push(`${d.bot} rejoined without a game-state snapshot`);
    if (r.players.length === 2) {
      const other = r.players.find((n) => n !== d.bot);
      if (!r.events.some((e) => e.bot === other && e.ev === "game-paused" && e.t > d.t)) consistency.push(`2 players: ${other} never got game-paused`);
      if (!r.events.some((e) => e.bot === other && e.ev === "game-resumed" && e.t > d.t)) consistency.push(`2 players: ${other} never got game-resumed`);
    }
  }
  // Pause N of M: every game-paused says which pause it is (the would-be number), never beyond the cap.
  // Re-sends within one pause keep the number; the next pause repeats it if the last one was refunded
  // (resumed within PAUSE_GRACE = 10 s) and is one more if it counted. Never going back.
  const PAUSE_GRACE_MS = 10_000, GRACE_SLACK_MS = 500; // near the boundary, network latency decides: accept both
  const lastPause = {};
  const pauseState = {}; // bot -> { number, startedAt, resumedAt }
  for (const e of r.events.filter((x) => x.ev === "game-paused" || x.ev === "game-resumed")) {
    const st = pauseState[e.bot] || (pauseState[e.bot] = { number: 0, startedAt: null, resumedAt: null });
    if (e.ev === "game-resumed") { if (st.startedAt !== null && st.resumedAt === null) st.resumedAt = e.t; continue; }
    const { pause, maxPauses } = e.payload;
    if (!Number.isInteger(pause) || !Number.isInteger(maxPauses) || pause < 1 || pause > maxPauses) { consistency.push(`${e.bot}: bad game-paused pause ${pause}/${maxPauses}`); continue; }
    const samePause = st.startedAt !== null && st.resumedAt === null;
    if (samePause) {
      if (pause !== st.number) consistency.push(`${e.bot}: pause number changed within one pause ${st.number} -> ${pause}`);
    } else if (st.startedAt !== null) {
      const lasted = st.resumedAt - st.startedAt;
      const allowed = lasted < PAUSE_GRACE_MS - GRACE_SLACK_MS ? [st.number]
        : lasted > PAUSE_GRACE_MS + GRACE_SLACK_MS ? [st.number + 1] : [st.number, st.number + 1];
      if (pause < st.number) consistency.push(`${e.bot}: pause number went back ${st.number} -> ${pause}`);
      else if (!allowed.includes(pause)) consistency.push(`${e.bot}: pause ${st.number} lasted ${lasted}ms, next pause should be ${allowed.join(" or ")}, got ${pause}`);
    }
    if (!samePause) Object.assign(st, { number: pause, startedAt: e.t, resumedAt: null });
    lastPause[e.bot] = pause;
  }
  const roundsSeen = [...new Set(starts.map((s) => s.round))].sort((a, b) => a - b);
  roundsSeen.forEach((n, i) => { if (n !== i + 1) consistency.push(`round numbering gap: expected ${i + 1}, got ${n}`); });
  const phaseGaps = [];
  for (const s of starts) {
    const rv = reveals.find((x) => x.bot === s.bot && x.round === s.round);
    if (rv) phaseGaps.push(rv.t - s.t - s.payload.duration);
  }
  return {
    code: r.code,
    reason: r.reason,
    players: r.players.length,
    rounds_played: roundsSeen.length,
    rounds_skipped: perBotMax(r, "round-skipped"),
    skipped_unavailable: r.events.filter((e) => e.ev === "photo-unavailable-sent").length,
    unavailable_skip_ms: { p50: pct(unavailableSkipMs, 50)?.toFixed(1), max: unavailableSkipMs.length ? Math.max(...unavailableSkipMs).toFixed(1) : null },
    waiting_photo: perBotMax(r, "waiting-photo"),
    waiting_photo_skew_ms: { p50: pct(waitSkews, 50)?.toFixed(1), max: waitSkews.length ? Math.max(...waitSkews).toFixed(1) : null },
    disconnects: r.events.filter((e) => e.ev === "chaos-disconnect" || e.ev === "planned-disconnect").length,
    resyncs: r.events.filter((e) => e.ev === "game-state").length,
    pauses: perBotMax(r, "game-paused"),
    max_pause_number: Math.max(0, ...Object.values(lastPause)),
    resumes: perBotMax(r, "game-resumed"),
    skew_ms: { p50: pct(skews, 50)?.toFixed(1), p95: pct(skews, 95)?.toFixed(1), max: skews.length ? Math.max(...skews).toFixed(1) : null },
    answer_phase_overrun_ms: { p50: pct(phaseGaps, 50)?.toFixed(1), max: phaseGaps.length ? Math.max(...phaseGaps).toFixed(1) : null },
    upload_ms: { p50: pct(r.uploads, 50)?.toFixed(0), max: r.uploads.length ? Math.max(...r.uploads).toFixed(0) : null },
    uploads_rate_limited: r.rateLimited,
    missed_events: missed, // phase events a player never received while offline (game-state resyncs them)
    consistency_errors: consistency,
    errors: r.errors,
  };
}

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N_ROOMS }, (_, i) => runRoom(i, args.code || null)));
const rooms = results.map(analyse);
const summary = {
  server: SERVER,
  rooms: rooms.length,
  bots_per_room: N_BOTS,
  duration_s: Math.round((Date.now() - t0) / 1000),
  pass: rooms.every((r) => r.reason === "game-over" && r.consistency_errors.length === 0 && r.errors.length === 0),
  worst_skew_ms: Math.max(...rooms.map((r) => Number(r.skew_ms.max || 0))),
  uploads_rate_limited: rooms.reduce((n, r) => n + r.uploads_rate_limited, 0), // >0: server limit too low for this load, not a game bug
  rooms_detail: rooms,
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ summary, events: results.map((r) => r.events) }, null, 2));
process.exit(summary.pass ? 0 : 1);
