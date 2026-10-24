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
const TIMEOUT_S = Number(args.timeout || 900);
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
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return { url: (await res.json()).url, ms: now() - t0 };
}

function runRoom(roomIdx, fixedCode) {
  return new Promise((resolve) => {
    const prefix = N_ROOMS > 1 ? `r${roomIdx}-` : "";
    const events = []; // {bot, ev, round, t, payload}
    const errors = [];
    const uploads = [];
    let code = fixedCode || null;
    let finished = 0;
    let started = false;
    const bots = [];

    const done = (reason) => {
      clearTimeout(timer);
      bots.forEach((b) => b.socket.disconnect());
      resolve({ code, events, errors, uploads, reason, players: bots.map((b) => b.name) });
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
        } catch (e) { errors.push(`${name} upload: ${e.message}`); }
      });
      socket.on("round-start", (d) => {
        rec("round-start", d.round, { owner: d.owner, photo: d.photo, duration: d.duration });
        bot.round = d.round;
        bot.guess = bot.players[Math.floor(Math.random() * bot.players.length)] || "";
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
    skew_ms: { p50: pct(skews, 50)?.toFixed(1), p95: pct(skews, 95)?.toFixed(1), max: skews.length ? Math.max(...skews).toFixed(1) : null },
    answer_phase_overrun_ms: { p50: pct(phaseGaps, 50)?.toFixed(1), max: phaseGaps.length ? Math.max(...phaseGaps).toFixed(1) : null },
    upload_ms: { p50: pct(r.uploads, 50)?.toFixed(0), max: r.uploads.length ? Math.max(...r.uploads).toFixed(0) : null },
    missed_events: missed, // phase events a player never received (e.g. after a reconnect) — no resync
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
  rooms_detail: rooms,
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ summary, events: results.map((r) => r.events) }, null, 2));
process.exit(summary.pass ? 0 : 1);
