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
//            --drop-round R --drop-secs S [--drop-bot K]
//                           bot K (1-based, default the last one) drops at round R's round-start and reconnects
//                           S seconds later (rejoin + game-state snapshot). With --bots 2 the game must pause
//                           (game-paused) and resume (game-resumed) for the other bot. Each pause carries
//                           pause N of maxPauses (3 per game, each with a full 5 min countdown; a 4th ends the game).
//   node qa/lab/bots.mjs --bots 3 --host --drop-round 2 --drop-secs 3     # drop mid-round, game goes on
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8     # 2 players: pause → resume
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
const NO_READY = Number(args["no-ready"] || 0);
const TIMEOUT_S = Number(args.timeout || 900);
const DROP_ROUND = Number(args["drop-round"] || 0);
const DROP_SECS = Number(args["drop-secs"] || 5);
const DROP_BOT = Number(args["drop-bot"] || N_BOTS) - 1;
const PHOTOS = args.photos ? fs.readdirSync(args.photos).filter((f) => f.endsWith(".jpg")).map((f) => path.join(args.photos, f)) : [];

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);

async function uploadPhoto(label) {
  const t0 = now();
  let blob;
  if (PHOTOS.length) blob = new Blob([fs.readFileSync(PHOTOS[Math.floor(Math.random() * PHOTOS.length)])], { type: "image/jpeg" });
  else blob = new Blob([Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64")], { type: "image/jpeg" });
  const form = new FormData();
  form.append("image", blob, `${label}.jpg`);
  const res = await fetch(`${SERVER}/upload`, { method: "POST", body: form });
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

    const done = (reason) => {
      clearTimeout(timer);
      bots.forEach((b) => b.socket.disconnect());
      resolve({ code, events, errors, uploads, rateLimited, reason, players: bots.map((b) => b.name) });
    };
    const timer = setTimeout(() => { errors.push(`timeout after ${TIMEOUT_S}s`); done("timeout"); }, TIMEOUT_S * 1000);

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
        if (isHost || code) join();
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
        rec("your-turn", d.round);
        if (Math.random() < UPLOAD_FAIL) { rec("upload-skipped-on-purpose", d.round); return; }
        try {
          await sleep(200 + Math.random() * 800); // gallery pick on a phone
          const up = await uploadPhoto(name);
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
        bot.guess = bot.players[Math.floor(Math.random() * bot.players.length)] || "";
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
      socket.on("round-skipped", () => rec("round-skipped", bot.round));
      // Rejoin snapshot: catch up like the app does (guess in reveal, im-ready in the ready phase)
      socket.on("game-state", (d) => {
        rec("game-state", d.round, { phase: d.phase, paused: !!d.pause, pause: d.pause?.pause, maxPauses: d.pause?.maxPauses, started: d.started });
        if (!d.started) return;
        bot.players = d.players.map((p) => p.username);
        if (d.round !== bot.round) { bot.round = d.round; bot.guess = bot.players[Math.floor(Math.random() * bot.players.length)] || ""; }
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
  const missed = {};
  for (const [k, es] of byKey) {
    for (const name of r.players) if (!es.some((e) => e.bot === name)) (missed[name] ||= []).push(k);
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
  // Pause N of M: every game-paused says which pause it is, never beyond the cap, never going back
  const lastPause = {};
  for (const e of r.events.filter((x) => x.ev === "game-paused")) {
    const { pause, maxPauses } = e.payload;
    if (!Number.isInteger(pause) || !Number.isInteger(maxPauses) || pause < 1 || pause > maxPauses) consistency.push(`${e.bot}: bad game-paused pause ${pause}/${maxPauses}`);
    else if (pause < (lastPause[e.bot] || 0)) consistency.push(`${e.bot}: pause number went back ${lastPause[e.bot]} -> ${pause}`);
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
    rounds_skipped: new Set(r.events.filter((e) => e.ev === "round-skipped").map((e) => e.round)).size,
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
