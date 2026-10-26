#!/usr/bin/env node
// Headless ExposeMe players. They speak the same socket protocol as the app
// (see Server/GAME_FLOW.md), so they can fill a room next to real devices,
// load-test the server, and measure sync: how far apart each player receives
// the same phase event, and whether every player saw the same game.
//
//   node qa/lab/bots.mjs --bots 4 --host --rounds 10 --wait-players 6 --code-file /tmp/code
//   node qa/lab/bots.mjs --bots 3 --code K7MQ4X          # join an existing room (code in any case)
//   node qa/lab/bots.mjs --rooms 20 --bots 4 --host       # load: 20 parallel rooms
//   node qa/lab/bots.mjs --bots 2 --code K7MQ4X --name-prefix b-   # 2nd process in a room: names b-bot1, b-bot2
//            (all bots share one IP: use a server started by lab.sh, which lifts the per-IP socket limits)
//   --help prints the options (no network); unknown options exit 2. The server in use is printed at start.
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
//            --drop-rounds R1,R2,...  like --drop-round, one drop at each listed round (EXP-096). With --bots 2 every
//                           drop must pause and resume the game until the pauses are used up; the drop that would need a
//                           4th counted pause or an 11th in all must end the game at once (game-over, no game-paused).
//                           Pick S well away from the 10 s grace (refunded: S <= 5, counted: S >= 15).
//   node qa/lab/bots.mjs --bots 3 --host --drop-round 2 --drop-secs 3     # drop mid-round, game goes on
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8     # 2 players: pause → resume
//   node qa/lab/bots.mjs --bots 2 --host --rounds 15 --drop-rounds 1,2,3,4,5,6,7,8,9,10,11 --drop-secs 3
//                           # 10 refunded pauses (pause 1 of 3 every time), the 11th drop ends the game
//            --drop-on-turn the planned drop happens instead on the first your-turn from round R on, by whichever bot
//                           gets it (--drop-bot is ignored): the photo owner drops during waiting-photo before sending
//                           its photo and returns S seconds later. Its photo must still be played (EXP-226): it sends
//                           it after its return and that round is not skipped by timeout ("consistency").
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 1 --drop-secs 3 --drop-on-turn   # owner's return resumes
//            --app-resync   after a rejoin snapshot of a started game, ignore it (and your-turn) and re-send the join
//                           on the same socket, like the app going from its lobby to the game screen (EXP-097)
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8 --app-resync
//            --photo-unavailable P   on its turn a bot reports photo-unavailable { round, attempt } with probability P (like a phone with no
//                           gallery access / no photos / failed uploads): the round must be skipped at once for everyone
//                           (round-skipped reason "unavailable"), not after the 15 s wait. --upload-fail P instead stays
//                           silent, so the server skips by timeout (reason "timeout").
//   node qa/lab/bots.mjs --bots 3 --host --photo-unavailable 0.3
//            --plant K      the first K bots plant a photo like the app: upload + plant-photo in the lobby, right after
//                           joining (im-ready never waits for it). Planted rounds must look like any other (EXP-126):
//                           every bot gets waiting-photo before round-start, nobody gets your-turn for them
//                           ("consistency"), and no payload says who planted or who is ready ("payload-leak"; only a
//                           bot's own room-of-game has its own planted mark, and it must be true after planting).
//   node qa/lab/bots.mjs --bots 3 --host --plant 2
//            --lobby-host-drop  once everyone joined, the host bot drops in the lobby and never comes back (EXP-157):
//                           after the 15 s disconnect grace (not before) every other bot gets player-connection
//                           { host, connected: false } and new-host for the second bot, which then starts the game; the
//                           old host is removed at game start (not in game-started) and the game runs to game-over.
//                           With --bots 1 (one bot host + real devices, see qa/maestro/lobby-host-drop.yaml) no bot is
//                           left: the run ends right after the drop (reason "lobby-host-drop") and the device checks it.
//   node qa/lab/bots.mjs --bots 3 --host --lobby-host-drop
//            --play-again-linger S  after game-over every bot stays connected on the final screens (EXP-172, like the
//                           app): the others "Play again" at once (join-create-game on the same socket), the host lingers
//                           S seconds (more than the 15 s grace to matter) before its own Play again. Nobody may see
//                           player-connection { connected: false } or new-host after game-over, and every same-socket
//                           join must succeed with the same rejoin token, the host still host ("consistency").
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --play-again-linger 20
//            --play-again-linger-bot K  the bot that lingers (1-based, default 1 = the host). A non-host K: the host
//                           starts a second game as soon as the others are back, while K is still on the final screens.
//                           Like the app there (EXP-184, DEC-018 A), K is taken into it at once: on game-started it
//                           re-joins on the same socket (the lobby hand-over), gets the ready-phase snapshot and sends
//                           im-ready, then plays the whole second game. Second-game events are recorded as "g2-<event>"
//                           (kept apart from the first game's checks). "consistency": K joined the started game, played
//                           every second-game round, the second game's ready phase didn't wait for the ready timeout
//                           (first waiting-photo < 8 s after game-started), K never had to decline a turn from the final
//                           screens, and no second-game round was skipped by the 15 s timeout. The run ends when every
//                           bot got the second game's game-over.
//                           K = 0: no bot lingers (a device does, qa/maestro/play-again-linger.yaml): every bot plays
//                           again at once and stays in the lobby for S + 15 s before ending.
//   node qa/lab/bots.mjs --bots 2 --host --rounds 3 --play-again-linger 30 --play-again-linger-bot 2
//            --start-next-game D  with K = 0: once every bot is back in the lobby, the host starts a second game D seconds
//                           after game-over while the device is still on its final screens; the device must be taken into
//                           it (qa/maestro/play-again-auto-join.yaml). Same second-game checks as above (ready phase
//                           shorter than 8 s, no timeout skips); the run ends with the second game's game-over.
//   node qa/lab/bots.mjs --bots 2 --host --rounds 3 --play-again-linger 1 --play-again-linger-bot 0 --start-next-game 15
//            --leave-round R  the last bot leaves at round R's round-start exactly like the app's Exit (leave-room and
//                           closes its socket in the same tick; EXP-139; a "never got player-left" failure is app bug EXP-254). Every other bot gets player-left and drops it
//                           from its answer options; it is in no later round-scores nor answer, and the game goes on while
//                           2 players remain (with 2 bots the other one gets game-over at once) ("consistency").
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --leave-round 2
//            --kick NAME[@R]  the host bot removes NAME (remove-player, EXP-139): in the lobby 5 s after NAME is in (the
//                           game then starts without it), or at round R's round-start. Every bot gets player-removed
//                           { NAME }; NAME is in no later game-started, round-scores or answer, and nobody guesses it. A
//                           kicked bot gets player-removed itself, then the server closes its connection ("kicked-out")
//                           and it gets no more game events ("consistency"). NAME may be a device's: with one bot host and
//                           the device alone (qa/maestro/kicked-notice.yaml) nobody is left to play, so the run ends right
//                           after the kick (reason "lobby-kick") and the device checks its notice.
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --kick bot3@2
//   Checks and metrics of each room: qa/lab/bots-analysis.mjs (tested on recorded events by qa/lab/tests/bots-analysis.test.sh).
//   Every bot records waiting-photo { round, duration } (room-wide, owner secret): same payload for all, skew measured.
//   Photos: uploads send the room code + the bot's rejoin token (X-Game-Code / Authorization: Bearer), like the app;
//   on each round-start one non-owner bot GETs the photo with them (must be 200) and without (must be 401): "photo-access".
//   Payload privacy (EXP-017/EXP-027/EXP-126): every event a bot receives is scanned; no socketId / rejoinToken /
//   plantedPhoto / hasPlantedPhoto / isReady key (except the bot's own token and planted mark at the top of room-of-game), no socket id or other bot's token as a value; during
//   answering/reveal no player in room-of-game / game-state (players and scores) / new-host / player-removed shows
//   this round's guess or more points than at the last round-scores; a waiting-photo game-state has no owner/photo:
//   "payload-leak".
//   Photo owner secrecy (EXP-128, EXP-252): no payload has an `owner` / `isOwner` key; round-start is exactly
//   { photo, round, duration } (the same for every bot, owner included) and an answering game-state has no
//   correctAnswer, so before round-reveal nobody, not even the owner, can tell whose photo it is ("payload-leak").
//   The owner plays like everyone: every bot, the owner included, guesses at random among all players (itself too),
//   and each round-scores row is scored by its guess like any other ("consistency").
//   Answers (EXP-148): like the app, a bot sends submit-answer while answering (sometimes a first pick changed once:
//   the last one counts), never at the reveal. At each round-reveal the first bot also sends the revealed answer, which
//   the server must ignore: every bot's lastGuess in round-scores equals its last pick sent while answering ("" if
//   none) ("consistency"; bots that went offline are left out). round-start's duration is the answer time minus a
//   300 ms grace (answers are taken until the real end); bots send at most 3 picks per round (server limit: 10 per
//   socket, refilled 5/s), and there are no correct-answer / incorrect-answer aliases.
//   Turns: like the app, a bot drops the photo (or photo-unavailable) of a your-turn whose request ended before it was
//   ready (waiting-photo, round-start, round-skipped, game-paused, game-state, game-over in between): "turn-dropped".
//   A turn dropped while connected must be asked again (a later your-turn for that round) or skipped for a reason
//   other than timeout ("consistency").
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import { analyseRoom } from "./bots-analysis.mjs";

// ── Command line ──
// Parsed and validated before anything touches the network (EXP-197): --help and bad arguments never connect
const BOOL_FLAGS = new Set(["host", "no-answer", "app-resync", "lobby-host-drop", "drop-on-turn", "help"]);
const VALUE_FLAGS = new Set([
  "server", "bots", "rooms", "rounds", "wait-players", "code", "code-file", "photos", "out", "chaos", "upload-fail",
  "timeout", "no-ready", "drop-round", "drop-rounds", "drop-secs", "drop-bot", "photo-unavailable", "plant", "play-again-linger",
  "play-again-linger-bot", "start-next-game", "name-prefix", "leave-round", "kick",
]);
const USAGE = `usage: node qa/lab/bots.mjs [options]

Headless ExposeMe players (see the header of qa/lab/bots.mjs for every scenario).

  --server URL               server to play against (default: $SERVER_URL, else http://localhost:3000,
                             the SHARED lab server: pass your own when you run your own server);
                             loopback hosts only (localhost, 127.x, [::1]), anything else exits 2
  --bots N                   bots per room (default 3)
  --host                     the first bot creates the room and starts the game
  --code CODE                join an existing room instead (6 characters, any case)
  --rooms N                  parallel rooms (load test, default 1)
  --name-prefix P            prepend P to every bot name (letters, digits, "-", "_"), so a second bots process can
                             join the same room (--code) without name clashes, e.g. --name-prefix b-  ->  b-bot1
  --rounds R                 3 (QA servers only), 10, 15 or 20 (default 10; anything else exits 2)
  --wait-players N           host starts once N players are in (default --bots)
  --code-file FILE           write the created room code here
  --photos DIR  --out FILE   photos to upload (*.jpg) / write the summary + events as JSON
  --timeout S                give up after S seconds (default 900)
  --chaos P  --upload-fail P  --photo-unavailable P  --no-ready K  --no-answer  --plant K
  --drop-round R | --drop-rounds R1,R2,...  --drop-secs S [--drop-bot K | --drop-on-turn (--drop-round only)]
  --app-resync  --lobby-host-drop
  --leave-round R            the last bot leaves the room (leave-room) at round R's round-start
  --kick NAME[@R]            the host bot removes NAME (remove-player): in the lobby once NAME is in, or at round R
  --play-again-linger S [--play-again-linger-bot K] [--start-next-game D]
  --help, -h                 print this help and exit (no network)

Exit codes: 0 pass, 1 fail, 2 bad arguments.`;

/** argv (without node and script) -> { args } or { error }; { help: true } for --help / -h. */
function parseCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (!a.startsWith("--")) return { error: `unexpected argument "${a}"` };
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) { args[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) return { error: `unknown option "${a}"` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `option "${a}" needs a value` };
    args[name] = v;
    i++;
  }
  return { args };
}

/** "2, 5,7" -> [2, 5, 7] (ascending, no repeats), or null unless every item is a round number (integer >= 1). */
function parseRoundList(value) {
  const items = value.split(",").map((s) => s.trim());
  if (!items.every((s) => /^[1-9][0-9]*$/.test(s))) return null;
  return [...new Set(items.map(Number))].sort((a, b) => a - b);
}

/** Bad command line: say why and exit 2, before any network activity. */
const exitUsage = (message) => { console.error(`bots.mjs: ${message} (see --help)`); process.exit(2); };

const cli = parseCli(process.argv.slice(2));
if (cli.help) { console.log(USAGE); process.exit(0); }
if (cli.error) exitUsage(cli.error);
const args = cli.args;
// Room codes: 6 characters of the server's alphabet (Server/managers/roomCode.ts), typed in any case like in the app
// (ASCII-only normalization: toUpperCase would turn "ß" into "SS", so non-ASCII input stays malformed)
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`);
const normalizeRoomCode = (code) => code.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[a-z]/g, (c) => c.toUpperCase());
const FIXED_CODE = args.code ? normalizeRoomCode(args.code) : null;
if (FIXED_CODE && !ROOM_CODE_RE.test(FIXED_CODE)) exitUsage(`--code "${args.code}" is not a room code (6 characters, e.g. K7MQ4X)`);
// Round counts set-rounds accepts, as in Server/managers/RoomManager.ts (ROUND_OPTIONS, and QA_ROUNDS only with
// ALLOW_QA_ROUNDS=1 on the server); qa/lab/tests/bots-cli.test.sh checks the copies match (EXP-203)
const ROUND_OPTIONS = [10, 15, 20];
const QA_ROUNDS = 3;
const DEFAULT_ROUNDS = 10;
if (args.rounds !== undefined && ![QA_ROUNDS, ...ROUND_OPTIONS].includes(Number(args.rounds))) {
  exitUsage(`--rounds "${args.rounds}" is not a round count the server accepts (${QA_ROUNDS} on QA servers, ${ROUND_OPTIONS.join(", ")})`);
}
/** Rounds with a planned drop (EXP-096): --drop-round R is a single drop, --drop-rounds R1,R2,... one per listed round. */
function plannedDropRounds() {
  const single = args["drop-round"], list = args["drop-rounds"];
  if (single !== undefined && list !== undefined) exitUsage("use --drop-round or --drop-rounds, not both");
  if (list !== undefined) {
    if (args["drop-on-turn"]) exitUsage("--drop-on-turn takes a single --drop-round");
    return parseRoundList(list) ?? exitUsage(`--drop-rounds "${list}" is not a list of round numbers (e.g. 2,4,6)`);
  }
  if (single === undefined) return [];
  const rounds = parseRoundList(single);
  if (rounds?.length !== 1) exitUsage(`--drop-round "${single}" is not a round number (several drops: --drop-rounds)`);
  return rounds;
}
const DROP_ROUNDS = plannedDropRounds();
const SERVER = args.server || process.env.SERVER_URL || "http://localhost:3000";
// QA traffic never leaves this machine (no production, no other hosts): only loopback servers, like lab.sh server's
const isLoopbackHost = (host) => host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
const isLocalServerUrl = (url) => {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
};
if (!isLocalServerUrl(SERVER)) {
  exitUsage(`server "${SERVER}"${args.server ? "" : " (from $SERVER_URL)"} is not a local lab server: bots only play against localhost / 127.x / [::1]`);
}
const N_BOTS = Number(args.bots || 3);
const N_ROOMS = Number(args.rooms || 1);
// Bot names: [--name-prefix][r<room>- with --rooms > 1]bot<n>. The server refuses longer usernames
// (Server/routes/socketRoutes.ts; qa/lab/tests/bots-cli.test.sh checks the copy matches)
const MAX_USERNAME_LENGTH = 20;
const NAME_PREFIX_RE = /^[A-Za-z0-9_-]+$/;
const NAME_PREFIX = args["name-prefix"] ?? "";
const botName = (roomIdx, i) => `${NAME_PREFIX}${N_ROOMS > 1 ? `r${roomIdx}-` : ""}bot${i + 1}`;
if (args["name-prefix"] !== undefined) {
  if (!NAME_PREFIX_RE.test(NAME_PREFIX)) exitUsage(`--name-prefix "${NAME_PREFIX}" may only use letters, digits, "-" and "_"`);
  const longest = botName(N_ROOMS - 1, N_BOTS - 1);
  if (longest.length > MAX_USERNAME_LENGTH) {
    exitUsage(`--name-prefix "${NAME_PREFIX}" is too long: "${longest}" exceeds the server's ${MAX_USERNAME_LENGTH}-character usernames`);
  }
}
const ROUNDS = Number(args.rounds || DEFAULT_ROUNDS);
const WAIT_PLAYERS = Number(args["wait-players"] || N_BOTS);
const CHAOS = Number(args.chaos || 0);
const UPLOAD_FAIL = Number(args["upload-fail"] || 0);
const PHOTO_UNAVAILABLE = Number(args["photo-unavailable"] || 0);
const NO_READY = Number(args["no-ready"] || 0);
const PLANT = Number(args.plant || 0);
const NO_ANSWER = !!args["no-answer"];
// --no-answer: bots submit an empty guess like a player who never taps, so nobody scores (tie at 0).
// Nobody is told whose photo it is, the owner included (EXP-252): every bot guesses at random among all players.
const pickGuess = (bot) => {
  if (NO_ANSWER) return "";
  return bot.players[Math.floor(Math.random() * bot.players.length)] || "";
};
const TIMEOUT_S = Number(args.timeout || 900);
const DROP_ROUND = DROP_ROUNDS[0] ?? 0; // --drop-on-turn: the first round whose turn triggers the drop
const DROP_SECS = Number(args["drop-secs"] || 5);
const DROP_BOT = Number(args["drop-bot"] || N_BOTS) - 1;
const DROP_ON_TURN = !!args["drop-on-turn"];
// Events that end the photo request in force, as GAME_FLOW.md lists them: the app drops the result of a turn in flight
const TURN_ENDING_EVENTS = new Set(["waiting-photo", "round-start", "round-skipped", "game-paused", "game-state", "game-over"]);
// Like the app rejoining from its lobby screen ("Join" after closing it): the first snapshot of a started game
// (and any your-turn with it) is missed while switching screens, then the join is re-sent on the same socket,
// which answers with a fresh game-state (and your-turn for an awaited photo)
const APP_RESYNC = !!args["app-resync"];
const LOBBY_HOST_DROP = !!args["lobby-host-drop"];
const PLAY_AGAIN_LINGER_S = Number(args["play-again-linger"] || 0);
const LINGER_BOT = Number(args["play-again-linger-bot"] || 1) - 1;
const START_NEXT_GAME_S = Number(args["start-next-game"] || 0); // K = 0: the bots start a 2nd game while a device lingers

// ── Players out of the room (EXP-139) ──
/** --leave-round R: the round at whose round-start the last bot leaves (0: nobody leaves). */
function plannedLeaveRound() {
  const value = args["leave-round"];
  if (value === undefined) return 0;
  const rounds = parseRoundList(value);
  if (rounds?.length !== 1) exitUsage(`--leave-round "${value}" is not a round number`);
  return withinHostedGame("--leave-round", rounds[0]);
}
/** A planned exit at `round` must happen in the game: with --host the bots set its length (--rounds). */
function withinHostedGame(option, round) {
  if (args.host && round > ROUNDS) exitUsage(`${option}: round ${round} is beyond the game's ${ROUNDS} rounds (--rounds)`);
  return round;
}
/** --kick NAME[@R] -> { name, round } (round 0: in the lobby, once NAME is in), null without --kick. */
function plannedKick() {
  const value = args.kick;
  if (value === undefined) return null;
  const [, name = "", round] = value.match(/^(.*?)(?:@([1-9][0-9]*))?$/s);
  if (!args.host) exitUsage("--kick needs --host (only the host can remove a player)");
  if (N_ROOMS > 1) exitUsage("--kick takes a single room (bot names differ per room)");
  if (!name || name.trim() !== name || name.length > MAX_USERNAME_LENGTH) {
    exitUsage(`--kick "${value}": "${name}" is not a username (1-${MAX_USERNAME_LENGTH} characters, no surrounding spaces)`);
  }
  if (name === botName(0, 0)) exitUsage(`--kick "${value}": the host can't remove itself`);
  return { name, round: round ? withinHostedGame("--kick", Number(round)) : 0 };
}
const LEAVE_ROUND = plannedLeaveRound();
const LEAVER = N_BOTS - 1; // the bot that leaves with --leave-round
// A lobby kick waits this long after NAME joined, like a host reading the list (and so a device's flow sees its lobby)
const LOBBY_KICK_DELAY_MS = 5_000;
const KICK_SETTLE_MS = 1_000; // after a lobby kick that ends the run: time for the kicked player to get its notice
const KICK = plannedKick();
const LOBBY_KICK = KICK?.round === 0;
// What the room checks need to know about this run (qa/lab/bots-analysis.mjs)
const ANALYSIS_OPTS = { host: !!args.host, rounds: ROUNDS, playAgainLingerS: PLAY_AGAIN_LINGER_S, lingerBot: LINGER_BOT, startNextGameS: START_NEXT_GAME_S };
const PHOTOS = args.photos ? fs.readdirSync(args.photos).filter((f) => f.endsWith(".jpg")).map((f) => path.join(args.photos, f)) : [];

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /upload and /temp only answer members of the photo's room: room code + the bot's rejoin token (never logged)
const photoAuth = (code, token) => ({ Authorization: `Bearer ${token}`, "X-Game-Code": code });

const PRIVATE_KEYS = new Set(["socketId", "rejoinToken", "plantedPhoto", "hasPlantedPhoto", "isReady"]);
// Only in the receiver's own room-of-game, at its top level (its token and its own planted mark)
const OWN_KEYS = new Set(["rejoinToken", "hasPlantedPhoto"]);

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
        if (PRIVATE_KEYS.has(k) && !(ev === "room-of-game" && p === "0" && OWN_KEYS.has(k))) out.push(`${ev} ${p}.${k}: private key`);
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
  // Nor can the scores' order (EXP-252): a hidden correct guess must not lift anyone past a tied player. It is the
  // order round-scores uses on the shown points: highest first, ties in room order (the players list's order)
  if (ev === "game-state" && state?.started && inRound(state.phase)) {
    const shown = (state.scores ?? []).map((s) => s.username);
    const points = new Map((state.scores ?? []).map((s) => [s.username, s.points]));
    const expected = (state.players ?? []).map((p) => p.username).filter((n) => points.has(n))
      .sort((a, b) => points.get(b) - points.get(a));
    if (shown.join() !== expected.join()) out.push(`game-state.scores: order [${shown}] during ${state.phase}, expected [${expected}]`);
  }
  // Single-player events while the round is in play (phase as this bot last saw it)
  if ((ev === "new-host" || ev === "player-removed") && inRound(ctx.phase)) checkHidden([payload[0]], ev, ctx.phase);
  // The owner is secret while the photo is awaited
  if (ev === "game-state" && state?.phase === "waiting-photo" && state.photo != null) {
    out.push(`game-state: photo set during waiting-photo`);
  }
  // The owner is secret until round-reveal, also to the owner (EXP-128, EXP-252): no `owner` / `isOwner` key anywhere
  const hasOwnerKey = (v) => Array.isArray(v) ? v.some(hasOwnerKey)
    : !!v && typeof v === "object" && ("owner" in v || "isOwner" in v || Object.values(v).some(hasOwnerKey));
  if (hasOwnerKey(payload)) out.push(`${ev}: payload has an owner key`);
  if (ev === "round-start") {
    const keys = Object.keys(payload[0] ?? {}).sort().join(",");
    if (keys !== "duration,photo,round") out.push(`round-start: keys [${keys}] (only photo, round, duration)`);
  }
  if (ev === "game-state" && state?.started && state.phase === "answering" && state.correctAnswer != null) {
    out.push(`game-state: correctAnswer set during answering`);
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
  if (res.status === 429 || res.status === 503) {
    // Server limit, not a game bug: name the knob from the body's `scope` (in-flight caps, storage limits) or the error
    const body = await res.json().catch(() => ({}));
    const knob = {
      member: "UPLOAD_INFLIGHT_PER_MEMBER_MAX", room: "UPLOAD_INFLIGHT_PER_ROOM_MAX", ip: "UPLOAD_INFLIGHT_PER_IP_MAX", server: "UPLOAD_INFLIGHT_MAX",
    }[body.scope];
    const storageKnob = { storage: "UPLOAD_STORED_MAX", "lobby-ip": "UPLOAD_LOBBY_PER_IP_MAX" }[body.scope];
    const hint = knob ? `too many uploads in progress, raise ${knob}`
      : storageKnob ? `too many photos stored, raise ${storageKnob}`
      : res.status === 503 ? "image processing took longer than SANITIZE_QUEUE_TIMEOUT_MS (controllers/sanitizeImage.ts)"
      : "rate-limited, raise UPLOAD_PLAYER_RATE_MAX / UPLOAD_ROOM_RATE_MAX (or the room holds 100 photos)";
    throw Object.assign(new Error(`upload ${res.status} ${hint} on the server`), { rateLimited: true });
  }
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return { url: (await res.json()).url, ms: now() - t0 };
}

function runRoom(roomIdx, fixedCode) {
  return new Promise((resolve) => {
    const events = []; // {bot, ev, round, t, payload}
    const errors = [];
    const uploads = [];
    let rateLimited = 0; // uploads refused with 429/503 (server limits, not a game bug)
    let code = fixedCode || null;
    let finished = 0;
    let started = false;
    let turnDropDone = false; // --drop-on-turn: one planned drop per room
    const bots = [];
    const socketIds = new Set(); // every socket id of this room's bots (they change on reconnect)

    const done = (reason) => {
      clearTimeout(timer);
      bots.forEach((b) => b.socket.disconnect());
      resolve({ code, events, errors, uploads, rateLimited, reason, players: bots.map((b) => b.name) });
    };
    const timer = setTimeout(() => {
      errors.push(`timeout after ${TIMEOUT_S}s`);
      if (LOBBY_KICK && !kick.scheduled) errors.push(kickTargetMissing());
      done("timeout");
    }, TIMEOUT_S * 1000);

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
      const name = botName(roomIdx, i);
      const isHost = !!args.host && i === 0;
      const socket = io(SERVER, { transports: ["websocket"], reconnection: true });
      const bot = { name, socket, isHost, players: [], guess: "", round: 0, token: null, plants: i < PLANT, droppedRounds: new Set() };
      bots.push(bot);
      // Second game (--play-again-linger-bot): recorded apart so the first game's checks only see the first game
      const rec = (ev, round, payload) =>
        events.push({ bot: name, ev: bot.game2 && ev !== "payload-leak" ? `g2-${ev}` : ev, round, t: now(), payload });

      // rejoinToken (from our own room-of-game) is required by the server to reconnect with the same username
      const join = () => socket.emit("join-create-game", { gameCode: isHost && !code ? null : code, username: name, ...(bot.token ? { rejoinToken: bot.token } : {}) });
      bot.join = join;
      socket.on("connect", () => {
        // Out of the room for good (left or kicked): a reconnect planned before that (--chaos) must not come back
        if (bot.gone) { socket.disconnect(); return; }
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
        if (TURN_ENDING_EVENTS.has(ev)) bot.turn = null;
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
        // Play again on the same socket after game-over (EXP-172): same token, still in the room, host kept
        if (bot.playAgainPending) {
          bot.playAgainPending = false;
          const me = d.room.players.find((p) => p.username === name);
          rec("play-again-joined", 0, {
            sameToken: d.rejoinToken === bot.token, isHost: !!me?.isHost, started: d.room.started,
            gone: d.room.players.filter((p) => p.connected === false).map((p) => p.username),
          });
          bot.playAgainDone = true;
          const live = bots.filter((b) => !b.gone);
          const lingerer = live.find((b) => b.lingers);
          // Taken into the second game from the final screens (EXP-184): the run ends with that game's game-over
          if (d.room.started) { /* the game-state snapshot that follows sends im-ready */ }
          // --play-again-linger-bot 0 --start-next-game D: the device is still on its final screens; start the next game
          else if (LINGER_BOT < 0 && START_NEXT_GAME_S && live.every((b) => b.playAgainDone)) {
            const host = live.find((b) => b.isHost);
            const wait = Math.max(300, START_NEXT_GAME_S * 1000 - (now() - (bot.gameOverAt ?? now())));
            setTimeout(() => host?.socket.emit("start-game", { gameCode: code }), wait);
          }
          // --play-again-linger-bot 0: a device lingers instead, so the bots stay (connected, in the lobby) a while
          // longer than it does, then end
          else if (live.every((b) => b.playAgainDone)) setTimeout(() => done("game-over"), LINGER_BOT < 0 ? PLAY_AGAIN_LINGER_S * 1000 + 15_000 : 500);
          // A non-host still on the final screens: the host starts the next game once everyone else is back
          else if (lingerer && !lingerer.isHost && live.every((b) => b.playAgainDone || b === lingerer)) {
            const host = live.find((b) => b.isHost);
            setTimeout(() => host?.socket.emit("start-game", { gameCode: code }), 300);
          }
        }
        if (d.rejoinToken) bot.token = d.rejoinToken;
        bot.players = d.room.players.map((p) => p.username);
        if (isHost && !code) {
          code = d.room.gameCode;
          if (args["code-file"]) fs.writeFileSync(args["code-file"], code);
          console.log(`[room ${roomIdx}] code ${code}`);
          // 3 is QA-only: the server accepts it only with ALLOW_QA_ROUNDS=1 (qa/lab/lab.sh server sets it)
          socket.emit("set-rounds", { gameCode: code, rounds: ROUNDS });
          bots.filter((b) => !b.isHost).forEach((b) => b.socket.connected && b.join());
        }
        // Like the app picking a photo to plant in the lobby: uploaded and planted at once
        if (bot.plants && !bot.plantSent && !d.room.started) plant();
        // Its own mark comes back only to itself, once the server has the photo
        if (bot.plantedAt && !d.room.started && d.hasPlantedPhoto !== true) errors.push(`${name}: room-of-game says not planted after plant-photo`);
        maybeStart();
      });
      socket.on("player-joined", (p) => { bot.players.push(p.username); maybeStart(); });
      // Someone left or was removed: no longer an answer option (like the app's game screen), a pick on them is redone
      const dropPlayer = (username) => {
        bot.players = bot.players.filter((x) => x !== username);
        if (bot.guess === username) bot.guess = pickGuess(bot);
      };
      socket.on("player-left", (n) => {
        rec("player-left", bot.round, { username: n });
        dropPlayer(n);
      });
      // Removed by the host (EXP-139). If it is us, the server closes our connection next: we are out of the room
      socket.on("player-removed", (p) => {
        rec("player-removed", bot.round, { username: p.username });
        if (p.username === name) { bot.gone = true; bot.kicked = true; return; }
        dropPlayer(p.username);
        if (bot.isHost && p.username === KICK?.name) onKickConfirmed();
      });
      socket.on("disconnect", (reason) => {
        if (bot.kicked && reason === "io server disconnect") rec("kicked-out", bot.round, { reason });
        if (bot.left || bot.kicked) endIfAllOut();
      });
      socket.on("player-connection", (d) => rec("player-connection", 0, d));
      socket.on("new-host", (p) => {
        rec("new-host", 0, { username: p.username });
        // The host role was handed to us (EXP-157): we start the game
        if (p.username === name && !bot.gone && !bot.isHost) { bot.isHost = true; maybeStart(); }
      });
      const plant = async () => {
        bot.plantSent = true;
        try {
          const up = await uploadPhoto(`${name}-planted`, photoAuth(code, bot.token));
          uploads.push(up.ms);
          socket.emit("plant-photo", { photoUrl: up.url });
          bot.plantedAt = now();
          rec("planted", 0);
          // Same-socket re-join (still in the lobby): its room-of-game must carry our own mark
          setTimeout(() => { if (!bot.inGame) join(); }, 100);
        } catch (e) {
          if (e.rateLimited) rateLimited++;
          errors.push(`${name} planted upload: ${e.message}`);
        }
      };
      socket.on("game-started", (players, rounds) => {
        if (PLAY_AGAIN_LINGER_S && bot.playAgainDone !== undefined) bot.game2 = true;
        if (bot.lingering) {
          // Like the app's final screens (EXP-184): join the next game at once, the way "Play again" does: re-join on
          // the same socket (lobby hand-over); its game-state snapshot (ready phase) makes us send im-ready
          rec("game-started-while-lingering", 0);
          clearTimeout(bot.lingerTimer);
          bot.lingering = false;
          bot.inGame = true;
          bot.players = players.map((p) => p.username);
          bot.playAgainPending = true;
          join();
          return;
        }
        bot.inGame = true;
        bot.players = players.map((p) => p.username);
        rec("game-started", 0, { rounds, players: [...bot.players] });
        if (i >= N_BOTS - NO_READY) { rec("im-ready-skipped-on-purpose", 0); return; }
        socket.emit("im-ready", { gameCode: code, username: name });
      });
      socket.on("your-turn", async (d) => {
        // On the final screens the app answers at once that it has no photo (EXP-172), so nobody waits for it
        if (bot.lingering) {
          rec("linger-photo-unavailable", d.round, { attempt: d.attempt });
          socket.emit("photo-unavailable", { round: d.round, attempt: d.attempt });
          return;
        }
        if (bot.resyncing) { rec("your-turn-missed-on-purpose", d.round); return; }
        rec("your-turn", d.round, { attempt: d.attempt });
        if (!Number.isInteger(d.attempt)) errors.push(`${name}: your-turn without an integer attempt`);
        if (DROP_ON_TURN && !turnDropDone && d.round >= DROP_ROUND) {
          turnDropDone = true;
          dropFor(DROP_SECS, d.round, { onTurn: true, attempt: d.attempt });
          return;
        }
        // This request, until an event ends it (TURN_ENDING_EVENTS): its result is sent only while it is in force
        const turn = { round: d.round, attempt: d.attempt };
        const turnAt = now(); // after its own your-turn record: a later your-turn re-asks for the round
        bot.turn = turn;
        const stillInForce = (result) => {
          if (bot.turn === turn) return true;
          rec("turn-dropped", d.round, { attempt: d.attempt, result, turnAt, connected: socket.connected });
          return false;
        };
        // One report per photo request (a re-sent your-turn of the same attempt doesn't report again)
        if (bot.reportedAttempt !== d.attempt && Math.random() < PHOTO_UNAVAILABLE) {
          bot.reportedAttempt = d.attempt;
          await sleep(100 + Math.random() * 300); // permission check / empty gallery on a phone
          // Like the app: a game-paused meanwhile ends this request; the server asks again on resume
          if (!stillInForce("photo-unavailable")) return;
          rec("photo-unavailable-sent", d.round, { attempt: d.attempt });
          socket.emit("photo-unavailable", { round: d.round, attempt: d.attempt });
          return;
        }
        if (Math.random() < UPLOAD_FAIL) { rec("upload-skipped-on-purpose", d.round); return; }
        try {
          await sleep(200 + Math.random() * 800); // gallery pick on a phone
          const up = await uploadPhoto(name, photoAuth(code, bot.token));
          uploads.push(up.ms);
          if (!stillInForce("photo")) return;
          socket.emit("photo-sent", { photo: up.url });
          rec("photo-sent", d.round, { attempt: d.attempt });
        } catch (e) {
          if (e.rateLimited) rateLimited++;
          errors.push(`${name} upload: ${e.message}`);
        }
      });
      socket.on("round-start", (d) => {
        bot.phase = "answering";
        // Every bot, the owner included, must get the same payload (its keys are checked in payloadLeaks)
        rec("round-start", d.round, { photo: d.photo, duration: d.duration });
        if (bot.lingering) return; // not playing: no guesses
        bot.round = d.round;
        if (KICK?.round === d.round && bot.isHost && !kick.sent) sendKick(bot, d.round);
        if (LEAVE_ROUND === d.round && i === LEAVER && !bot.gone) { leaveRoom(d.round); return; }
        bot.guess = pickGuess(bot);
        // Photo access: the first two bots load the photo like the app's <Image> (with credentials), and check that
        // it is refused without them
        if (i < 2) checkPhotoAccess(name, d.photo, photoAuth(code, bot.token), d.round);
        if (!DROP_ON_TURN && i === DROP_BOT && DROP_ROUNDS.includes(d.round) && !bot.droppedRounds.has(d.round)) {
          bot.droppedRounds.add(d.round);
          dropFor(DROP_SECS, d.round);
          return;
        }
        if (CHAOS && Math.random() < CHAOS) {
          rec("chaos-disconnect", d.round);
          socket.disconnect();
          setTimeout(() => { socket.connect(); }, 1500 + Math.random() * 2000);
        }
        // Like a player tapping during the answer time (8 s): sometimes a first pick, then the final one
        const round = d.round;
        const decoy = pickGuess(bot);
        if (decoy && decoy !== bot.guess && Math.random() < 0.5) setTimeout(() => {
          if (bot.round === round && bot.phase === "answering" && socket.connected) socket.emit("submit-answer", { guess: decoy });
        }, 200 + Math.random() * 400);
        setTimeout(() => sendGuess(round), 800 + Math.random() * 1200);
      });
      // --leave-round (EXP-139): exactly like the app's Exit (WaitingRoom / FinalScoreModal): leave-room and close the
      // socket in the same tick; this bot is out of the game. A leave the server never handles shows up as the others
      // never getting player-left ("consistency")
      const leaveRoom = (round) => {
        bot.gone = true;
        bot.left = true;
        rec("left-room", round);
        socket.emit("leave-room");
        socket.disconnect();
      };
      // Planned drop: offline for `secs`, then back on a new socket (rejoin + game-state snapshot)
      const dropFor = (secs, round, payload = {}) => {
        rec("planned-disconnect", round, { secs, ...payload });
        socket.disconnect();
        setTimeout(() => { socket.connect(); }, secs * 1000);
      };
      // Pick sent during answering only (EXP-148): the last one before the reveal is the one that counts
      const sendGuess = (round) => {
        if (!bot.guess || bot.round !== round || bot.phase !== "answering" || !socket.connected) return;
        socket.emit("submit-answer", { guess: bot.guess });
        rec("guess-sent", round, { guess: bot.guess });
      };
      socket.on("round-reveal", (d) => {
        bot.phase = "reveal";
        rec("round-reveal", bot.round, { correctAnswer: d.correctAnswer });
        // Fair play: a vote sent once the answer is public must be ignored (checked against round-scores)
        if (i === 0 && d.correctAnswer) {
          socket.emit("submit-answer", { guess: d.correctAnswer });
          rec("late-submit", bot.round, { guess: d.correctAnswer });
        }
      });
      socket.on("round-scores", (d) => { bot.phase = "scores"; rec("round-scores", d.round, { scores: d.scores }); });
      socket.on("waiting-photo", (d) => rec("waiting-photo", d.round, d));
      socket.on("round-skipped", (d) => rec("round-skipped", d?.round ?? bot.round, d));
      // Rejoin snapshot: catch up like the app does (pick again in answering, im-ready in the ready phase)
      socket.on("game-state", (d) => {
        rec("game-state", d.round, { phase: d.phase, paused: !!d.pause, pause: d.pause?.pause, maxPauses: d.pause?.maxPauses, started: d.started });
        // Offline when game-over was sent (EXP-092): the rejoin snapshot of our game says it is no longer started
        if (!d.started && bot.inGame) { rec("game-over-missed", bot.round); onGameOver(); return; }
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
        bot.phase = d.phase;
        if (d.phase === "answering") sendGuess(d.round); // a pick sent while offline was lost; never in reveal
        if (d.phase === null && i < N_BOTS - NO_READY) socket.emit("im-ready");
      });
      socket.on("game-paused", (d) => {
        // The server ignores photo-unavailable while paused and re-sends the same your-turn on resume (EXP-113):
        // that one must be answered again, so the attempt no longer counts as reported
        bot.reportedAttempt = undefined;
        rec("game-paused", bot.round, { waitingFor: d.waitingFor, duration: d.duration, pause: d.pause, maxPauses: d.maxPauses });
        console.error(`[room ${roomIdx}] ${name}: game-paused ${d.pause}/${d.maxPauses} (${Math.round(d.duration / 1000)}s), waiting for ${d.waitingFor.join(", ")}`);
      });
      socket.on("game-resumed", (d) => rec("game-resumed", bot.round, { phase: d.phase }));
      socket.on("hold-start", () => rec("hold-start", bot.round));
      socket.on("hold-resume", (d) => rec("hold-resume", bot.round, d));
      socket.on("game-over", (d) => {
        rec("game-over", bot.round, { finalScore: d.finalScore });
        onGameOver();
      });
      // game-over, received or learnt from a rejoin snapshot
      const onGameOver = () => {
        bot.inGame = false;
        if (PLAY_AGAIN_LINGER_S && !bot.gone) {
          if (bot.game2) {
            // The second game (started while someone lingered) ends the run
            bot.game2Over = true;
            if (bots.filter((b) => !b.gone).every((b) => b.game2Over)) setTimeout(() => done("game-over"), 500);
            return;
          }
          if (bot.playAgainDone !== undefined) return;
          bot.playAgainDone = false;
          bot.gameOverAt = now();
          // The socket stays open on the final screens; Play again re-joins on it (the lingering bot after S seconds)
          bot.lingers = i === LINGER_BOT;
          bot.lingering = bot.lingers;
          bot.lingerTimer = setTimeout(() => { bot.lingering = false; bot.playAgainPending = true; join(); }, bot.lingers ? PLAY_AGAIN_LINGER_S * 1000 : 300);
          return;
        }
        if (++finished === bots.filter((b) => !b.gone).length) done("game-over");
      };
      return bot;
    };

    // --kick (EXP-139): the host removes KICK.name once (in the lobby, or at round KICK.round's round-start)
    const kick = { scheduled: false, sent: false, confirmed: false };
    const kickTargetMissing = () => `--kick ${KICK.name} never joined the lobby`;
    const sendKick = (host, round) => {
      kick.sent = true;
      host.socket.emit("remove-player", { username: KICK.name });
      events.push({ bot: host.name, ev: "kick-sent", round, t: now(), payload: { username: KICK.name } });
    };
    // The host got player-removed for KICK.name. A lobby kick that leaves nobody to play with (one bot host and the
    // kicked device, qa/maestro/kicked-notice.yaml) ends the run: the device checks its notice
    const onKickConfirmed = () => {
      kick.confirmed = true;
      if (LOBBY_KICK && WAIT_PLAYERS - 1 < 2) setTimeout(() => done("lobby-kick"), KICK_SETTLE_MS);
      else maybeStart();
    };
    // Every bot of this process left (--leave-round with real devices playing on) or was kicked (by another bots
    // process' host): nothing more for them to do
    const endIfAllOut = () => { if (bots.every((b) => b.gone)) done("all-out"); };

    const maybeStart = () => {
      const host = bots.find((b) => b.isHost);
      if (!host || started || !code) return;
      // Lobby kick: NAME goes LOBBY_KICK_DELAY_MS after it is in, and the game starts without it once the server
      // confirmed it
      if (LOBBY_KICK && !kick.confirmed) {
        // Everyone the host waits for is in, and NAME is not one of them (a wrong name): nobody to kick
        if (!kick.scheduled && !host.players.includes(KICK.name) && host.players.length >= WAIT_PLAYERS) {
          errors.push(kickTargetMissing());
          done("kick-target-missing");
          return;
        }
        if (!kick.scheduled && host.players.includes(KICK.name)) {
          kick.scheduled = true;
          setTimeout(() => sendKick(host, 0), LOBBY_KICK_DELAY_MS);
        }
        return;
      }
      if (host.players.length >= WAIT_PLAYERS - (LOBBY_KICK ? 1 : 0)) {
        // EXP-157: the host drops in the lobby for good; whoever gets new-host starts instead
        if (LOBBY_HOST_DROP && !host.gone && !bots.some((b) => b.gone)) {
          host.gone = true;
          host.isHost = false;
          events.push({ bot: host.name, ev: "lobby-host-drop", round: 0, t: now() });
          host.socket.disconnect(); // manual disconnect: socket.io-client doesn't reconnect
          // Only real devices remain (Maestro checks the handover): nothing more for the bots to do
          if (bots.every((b) => b.gone)) done("lobby-host-drop");
          return;
        }
        started = true;
        setTimeout(() => host.socket.emit("start-game", { gameCode: code }), 500);
      }
    };

    for (let i = 0; i < N_BOTS; i++) makeBot(i);
  });
}

// Which server this run plays against (the default is the shared lab server: say so before connecting)
console.error(`bots.mjs: server ${SERVER}${args.server ? "" : process.env.SERVER_URL ? " (from $SERVER_URL)" : " (default: the shared lab server; pass --server for your own)"}`);
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N_ROOMS }, (_, i) => runRoom(i, FIXED_CODE)));
const rooms = results.map((r) => analyseRoom(r, ANALYSIS_OPTS));
// How a room may end and pass: at game-over, or on purpose before it, leaving only real devices behind
const expectedEnd = (reason) => reason === "game-over" || (LOBBY_HOST_DROP && reason === "lobby-host-drop")
  || (LOBBY_KICK && reason === "lobby-kick") || (LEAVE_ROUND > 0 && reason === "all-out");
const summary = {
  server: SERVER,
  rooms: rooms.length,
  bots_per_room: N_BOTS,
  duration_s: Math.round((Date.now() - t0) / 1000),
  pass: rooms.every((r) => expectedEnd(r.reason) && r.consistency_errors.length === 0 && r.errors.length === 0),
  worst_skew_ms: Math.max(...rooms.map((r) => Number(r.skew_ms.max || 0))),
  uploads_rate_limited: rooms.reduce((n, r) => n + r.uploads_rate_limited, 0), // >0: server limit too low for this load, not a game bug
  rooms_detail: rooms,
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ summary, events: results.map((r) => r.events) }, null, 2));
process.exit(summary.pass ? 0 : 1);
