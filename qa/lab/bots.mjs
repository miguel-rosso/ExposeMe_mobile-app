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
//   The host bot starts each game like the app: start-game with an ack, recorded as "start-ack" ({ ok, reason?,
//   removed? }); a refusal, or no ack within START_ACK_TIMEOUT_MS on a live connection, is an error (EXP-379).
//   options: --server URL  --photos DIR  --out FILE  --chaos 0.1  --upload-fail 0.2  --timeout 600
//            --no-ready K   the last K bots never send im-ready (game must start via the server's ready timeout)
//            --no-answer    bots always submit an empty guess (nobody scores: no result, DEC-044, see qa/maestro/no-result-game.yaml)
//            --answer-right bots vote for the round's owner whenever this run can tell it: one of its bots sent the
//                           photo, or exactly one player in the room is not one of its bots (EXP-348). They all end tied,
//                           above 0 with at most one other player (qa/maestro/tie-game.yaml). Each game's final score must
//                           show every bot on one point per revealed round whose owner it could tell, and more than 0 (a
//                           game nobody scored has no result) ("consistency", "tie: ..."). Not with --no-answer,
//                           --plant, --chaos, --drop-round(s), --leave-(offline-)round or --play-again-linger; the other players
//                           (devices) must play the whole game: the check counts them from game-started, so one leaving
//                           would let the bots tell owners the check does not expect them to.
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --answer-right       # bot1, bot2 and bot3 tied on 3 points
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
//                           its photo and returns S seconds later. With 2 bots (the game pauses) or 3+ bots and S under
//                           the server's 3 s owner return window, its photo must still be played (EXP-226): it sends
//                           it after its return and that round is not skipped by timeout. With 3+ bots and S over the
//                           window another bot must be asked for the same round right after the window, with no
//                           round-skipped, and the game still plays every round (EXP-029, DEC-035) ("consistency").
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 1 --drop-secs 3 --drop-on-turn   # owner's return resumes
//   node qa/lab/bots.mjs --bots 3 --host --drop-round 1 --drop-secs 6 --drop-on-turn   # owner too late: re-picked
//            --app-resync   after a rejoin snapshot of a started game, ignore it (and your-turn) and re-send the join
//                           on the same socket, like the app going from its lobby to the game screen (EXP-097)
//   node qa/lab/bots.mjs --bots 2 --host --drop-round 2 --drop-secs 8 --app-resync
//            --photo-unavailable P   on its turn a bot reports photo-unavailable { round, attempt } with probability P (like a phone with no
//                           gallery access / no photos / failed uploads): the round must be skipped at once for everyone,
//                           not after the 15 s wait. --upload-fail P instead stays silent, so the server skips by timeout.
//                           Only the owner's own round-skipped copy says reason ("unavailable" / "timeout"); the room's
//                           has none (EXP-110), and a reason in a copy for a bot not asked for that round's photo is
//                           a "payload-leak".
//   node qa/lab/bots.mjs --bots 3 --host --photo-unavailable 0.3
//            --plant K      the first K bots plant a photo like the app: upload + plant-photo in the lobby, right after
//                           joining (im-ready never waits for it). Planted rounds must look like any other (EXP-126):
//                           every bot gets waiting-photo before round-start, nobody gets your-turn for them
//                           ("consistency"), and no payload says who planted or who is ready ("payload-leak"; only a
//                           bot's own room-of-game has its own planted mark, and it must be true after planting).
//                           plant-photo must be acked { ok: true } within PLANT_ACK_TIMEOUT_MS (EXP-152).
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
//            --quit-after-game-over  at game-over the last bot closes its socket and never comes back (the app killed on
//                           the final screens: no leave-room), the others Play again at once, and the host starts the next
//                           game once the quitter has been gone longer than the server's 15 s disconnect grace (EXP-151).
//                           The start drops it: every other bot gets player-left for it before game-started, and it is in
//                           no second-game player list, round-scores or answer; the second game is played to game-over
//                           ("consistency"; second-game events are recorded as "g2-<event>"). Needs --host and 3+ bots.
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --quit-after-game-over
//            --leave-round R  the last bot leaves at round R's round-start exactly like the app's Exit (leave-room and
//                           closes its socket once the server acks it, EXP-139 / EXP-254). Every other bot gets player-left;
//                           like the app (DEC-038, EXP-301) it keeps the leaver as an answer option, and its pick on them,
//                           until the next waiting-photo (one who leaves between rounds is dropped at once). It is in no
//                           later round-scores nor answer, nobody guesses it in a later round, and the game goes on while
//                           2 players remain (with 2 bots the other one gets game-over at once) ("consistency").
//            --leave-owner  with --leave-round R, the bot that leaves is round R's photo owner (the one that sent its
//                           photo), not the last bot: it stays the round's answer. The first bot still in the room votes
//                           for it as soon as it gets player-left (a vote sent after the departure), so someone always
//                           does; every bot that votes for it must be scored correct with one more point in that
//                           round-scores, and a round where nobody did is reported ("consistency", EXP-301).
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --leave-round 2
//   node qa/lab/bots.mjs --bots 4 --host --rounds 3 --leave-round 2 --leave-owner
//            --leave-offline-round R  the last bot leaves at round R's round-start like the app's Exit pressed while
//                           offline (EXP-377, EXP-387): its connection drops, and 4 s later (past the server's 2 s
//                           minimum pause, when a rejoin would resume a paused game) it reconnects and sends leave-room
//                           naming its seat { gameCode, username, rejoinToken }, never a rejoin, closing on the ack. The
//                           same checks as --leave-round, and nobody may get game-resumed between that leave and its
//                           player-left (with 2 bots the other one sees the pause end only with game-over). Not with
//                           --leave-round. The leaver's run only ends once its seat leave is answered, and a leaver
//                           whose seat leave was never sent or acked is an error, also when it is the only bot of its
//                           process (Server/tests/botsOfflineLeave.integration.test.ts plays that shape).
//   node qa/lab/bots.mjs --bots 2 --host --rounds 3 --leave-offline-round 2
//                           With a device as the other player (one bot joins the device's room): the device shows
//                           «Game paused» for 4 s, then the final screen at once, never the game resuming first.
//   node qa/lab/bots.mjs --bots 1 --code K7MQ4X --leave-offline-round 1
//            --kick NAME    the host bot removes NAME (remove-player, EXP-139) in the lobby 5 s after NAME is in; the
//                           game then starts without it. The server only accepts it in the lobby (EXP-316), so there is
//                           no mid-game form (NAME@R is refused). Every bot gets player-removed { NAME }; NAME is in no
//                           game-started, round-scores or answer, and nobody guesses it. A kicked bot gets player-removed
//                           itself, then the server closes its connection ("kicked-out") and it gets no more game events
//                           ("consistency"). Then, like an app that was offline at the kick and comes back with its
//                           stored token (EXP-337), it joins again with that token on a new socket: the server must
//                           refuse it with "Removed by host" ("kick-rejoin-refused"); being let in, another refusal or
//                           no answer at all is an error. NAME may be a device's: with one bot host and the device alone
//                           (qa/maestro/kicked-notice.yaml) nobody is left to play, so the run ends right after the kick
//                           (reason "lobby-kick") and the device checks its notice.
//   node qa/lab/bots.mjs --bots 4 --host --rounds 3 --kick bot4
//            --kick-after-game D  with --kick NAME: NAME plays the whole game and the host removes it D seconds after
//                           game-over instead, between games (the server takes remove-player once the game is over).
//                           Every bot stays connected on the final screens until then (no Play again), and the run ends
//                           right after the kick (reason "game-over"); the same checks as a lobby kick apply. NAME may
//                           be a device's, still on its final ranking (qa/maestro/kicked-after-game.yaml) or offline by
//                           then, its app killed on the final screens (qa/maestro/kicked-while-offline.yaml). Not with
//                           --play-again-linger or --quit-after-game-over (they play a second game).
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --kick bot3 --kick-after-game 2
//            --hold P       like the app's hold button (EXP-303): on the scoreboard of a round whose revealed answer is its
//                           own name, a bot presses hold (hold-start) with probability P and lets go (hold-end) after a
//                           random time within the server's hold budget; like the app, it presses again (probability P)
//                           while the server's hold-end says holds are left (holdsLeft > 0, EXP-176), and never once
//                           it says 0 or the scoreboard's hold-closed came (EXP-354). With --chaos C it goes away
//                           instead of letting go
//                           with probability C: half the time it drops (back 1.5-3.5 s later), half the time it rejoins on a
//                           new socket while holding, like the app reconnecting before the server noticed its old
//                           connection was lost (EXP-299). Every player still in the room must get hold-end and
//                           hold-resume within 1 s of the holder letting go, leaving, dropping or rejoining, and of the
//                           server ending the hold itself (hold-resume is not due when a pause ended it), every hold-end
//                           must carry holdsLeft (at most 3 minus the round's holds so far), and the server must accept
//                           no hold in a round after saying none are left (a hold-end with 0, or hold-closed), whose
//                           scoreboard snapshots then say 0 too ("consistency"); summary: holds,
//                           hold_release_ms.
//                           play-rounds.yaml's simulator (qa/lab/tests/maestro-sim.mjs) models a single hold per round,
//                           not these presses again (EXP-355 will extend it).
//   node qa/lab/bots.mjs --bots 3 --host --rounds 3 --hold 1
//   node qa/lab/bots.mjs --bots 3 --host --rounds 10 --hold 0.5 --chaos 0.3
//   Checks and metrics of each room: qa/lab/bots-analysis.mjs (tested on recorded events by qa/lab/tests/bots-analysis.test.sh).
//   Every bot records waiting-photo { round, duration, gameNumber } (room-wide, owner secret; exactly WAITING_PHOTO_KEYS
//   in bots-analysis.mjs, see GAME_FLOW.md «Game number»): same payload for all, skew measured.
//   Photos: uploads send the room code + the bot's rejoin token (X-Game-Code / Authorization: Bearer), like the app;
//   on each round-start one non-owner bot GETs the photo with them (must be 200) and without (must be 401): "photo-access".
//   Payload privacy (EXP-017/EXP-027/EXP-126): every event a bot receives is scanned; no socketId / rejoinToken /
//   plantedPhoto / hasPlantedPhoto / isReady key (except the bot's own token and planted mark at the top of room-of-game), no socket id or other bot's token as a value; during
//   answering/reveal no player in room-of-game / game-state (players, scores, roundOptions) / new-host / player-removed shows
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
//   none) ("consistency"; bots that went offline are left out). Each bot's round-reveal (and a reveal/scores
//   game-state) carries its own recorded answer, `yourGuess` (EXP-230): it must equal that bot's lastGuess in the
//   round's round-scores ("consistency"). round-start's duration is the answer time minus a
//   800 ms grace (answers are taken until the real end); bots send at most 3 picks per round (server limit: 10 per
//   socket, refilled 5/s), and there are no correct-answer / incorrect-answer aliases.
//   Turns: like the app, a bot drops the photo (or photo-unavailable) of a your-turn whose request ended before it was
//   ready (waiting-photo, round-start, round-skipped, game-paused, game-state, game-over in between): "turn-dropped".
//   A turn dropped while connected must be asked again (a later your-turn for that round) or skipped for a reason
//   other than timeout ("consistency").
//   Resync timing (EXP-273): every game-state, game-resumed and hold-resume carries `phaseTotal`, the full countdown
//   of the phase (the `duration` its start event sent; `duration` itself when shown whole), never less than
//   `duration`; anything else is an error of the room.
import { io } from "socket.io-client";
import fs from "node:fs";
import path from "node:path";
import { analyseRoom, DISCONNECT_GRACE_MS, skipReasonLeak } from "./bots-analysis.mjs";

// ── Command line ──
// Parsed and validated before anything touches the network (EXP-197): --help and bad arguments never connect
const BOOL_FLAGS = new Set([
  "host", "no-answer", "answer-right", "app-resync", "lobby-host-drop", "drop-on-turn", "quit-after-game-over", "leave-owner", "help",
]);
const VALUE_FLAGS = new Set([
  "server", "bots", "rooms", "rounds", "wait-players", "code", "code-file", "photos", "out", "chaos", "upload-fail",
  "timeout", "no-ready", "drop-round", "drop-rounds", "drop-secs", "drop-bot", "photo-unavailable", "plant", "play-again-linger",
  "play-again-linger-bot", "start-next-game", "name-prefix", "leave-round", "leave-offline-round", "kick", "kick-after-game", "hold",
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
  --answer-right             every bot votes for the photo's owner when it can tell (a bot of this run sent the photo,
                             or one other player is in the room): the bots end tied with points (qa/maestro/tie-game.yaml)
  --drop-round R | --drop-rounds R1,R2,...  --drop-secs S [--drop-bot K | --drop-on-turn (--drop-round only)]
  --app-resync  --lobby-host-drop
  --leave-round R [--leave-owner]  the last bot (or, with --leave-owner, round R's photo owner) leaves the room
                             (leave-room) at round R's round-start
  --leave-offline-round R    the last bot drops at round R's round-start and, back 4 s later, leaves naming its seat
                             (the app's Exit while offline): nobody may see the game resume before its player-left
  --kick NAME                the host bot removes NAME (remove-player) in the lobby once NAME is in (lobby only)
  --kick-after-game D        with --kick: NAME plays the game and is removed D seconds after game-over instead
  --play-again-linger S [--play-again-linger-bot K] [--start-next-game D]
  --quit-after-game-over     the last bot quits at game-over; the next game must drop it (needs --host, 3+ bots)
  --hold P                   the round's owner bot holds the scoreboard with probability P (0 to 1) and lets go within
                             the server's hold budget, and again while holds are left; with --chaos C, instead of
                             letting go it drops or rejoins on a new socket while holding, with probability C
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
// (ASCII-only normalization: toUpperCase would turn "ß" into "SS", so non-ASCII input stays malformed);
// qa/lab/tests/bots-cli.test.sh checks the copies match
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const normalizeRoomCode = (code) => code.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[a-z]/g, (c) => c.toUpperCase());
const FIXED_CODE = args.code ? normalizeRoomCode(args.code) : null;
if (FIXED_CODE && !ROOM_CODE_RE.test(FIXED_CODE)) exitUsage(`--code "${args.code}" is not a room code (${ROOM_CODE_LENGTH} characters, e.g. K7MQ4X)`);
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
// (Server/managers/playerName.ts; qa/lab/tests/bots-cli.test.sh checks the copy matches)
const MAX_USERNAME_LENGTH = 15;
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
const CHAOS_AWAY_MS = [1_500, 3_500]; // a --chaos drop: back this long later (min, max)
const randomBetween = ([min, max]) => min + Math.random() * (max - min);

// ── Holding the scoreboard (--hold, EXP-303) ──
/** --NAME P: a probability (0 to 1), 0 when absent. */
function probabilityOption(name) {
  const value = args[name];
  if (value === undefined) return 0;
  const p = Number(value);
  if (value.trim() === "" || !(p >= 0 && p <= 1)) exitUsage(`--${name} "${value}" is not a probability (0 to 1)`);
  return p;
}
const HOLD = probabilityOption("hold");
// Hold time per round, as in Server/managers/GameEngine.ts (GAME_FLOW.md "Hold"; bots-cli.test.sh checks the copy)
const HOLD_BUDGET_PER_ROUND = 30_000;
// A hold lasts this long (min, max): a tap at least, and let go before the budget runs out (a later hold of the same
// round may still reach what is left of it and be force-released)
const HOLD_LENGTH_MS = [500, HOLD_BUDGET_PER_ROUND - 2_000];
// Pressed this long after round-scores (min, max): the scores phase lasts 5 s and a hold needs more than 1.5 s of it
// left (the server sends hold-closed when it gets there)
const HOLD_PRESS_DELAY_MS = [200, 1_500];
const UPLOAD_FAIL = Number(args["upload-fail"] || 0);
const PHOTO_UNAVAILABLE = Number(args["photo-unavailable"] || 0);
const NO_READY = Number(args["no-ready"] || 0);
const PLANT = Number(args.plant || 0);
const NO_ANSWER = !!args["no-answer"];
// --no-answer: bots submit an empty guess like a player who never taps, so nobody scores: no result (DEC-044).
// --answer-right (EXP-348): every bot votes for the round's owner whenever this run can tell it (knownOwner in
// runRoom), so all bots end tied, on one point per round played when at most one other player is in the room.
const ANSWER_RIGHT = !!args["answer-right"];
// Options that make a bot miss or change a vote (or hide who sent the photo) would break that tie
// (a bot lingering on the final screens sits the second game out)
const TIE_BREAKING_OPTIONS = ["no-answer", "plant", "chaos", "drop-round", "drop-rounds", "leave-round", "leave-offline-round", "play-again-linger"];
const tieBreaker = ANSWER_RIGHT && TIE_BREAKING_OPTIONS.find((o) => args[o] !== undefined);
if (tieBreaker) exitUsage(`--answer-right can't be combined with --${tieBreaker} (the bots would no longer tie)`);
// Otherwise nobody is told whose photo it is, the owner included (EXP-252): every bot guesses at random among all
// the round's options, those who left during the round included (DEC-038).
const pickGuess = (bot) => {
  if (NO_ANSWER) return "";
  if (ANSWER_RIGHT) return bot.knownOwner() ?? "";
  const options = [...bot.players, ...bot.leavers];
  return options[Math.floor(Math.random() * options.length)] || "";
};
// The phases of a round in play: a player who leaves then stays one of its options until the next waiting-photo
const ROUND_PHASES = new Set(["answering", "reveal", "scores"]);
const TIMEOUT_S = Number(args.timeout || 900);
const DROP_ROUND = DROP_ROUNDS[0] ?? 0; // --drop-on-turn: the first round whose turn triggers the drop
const DROP_SECS = Number(args["drop-secs"] || 5);
const DROP_BOT = Number(args["drop-bot"] || N_BOTS) - 1;
const DROP_ON_TURN = !!args["drop-on-turn"];
// Events that end the photo request in force, as GAME_FLOW.md lists them: the app drops the result of a turn in flight
const TURN_ENDING_EVENTS = new Set(["waiting-photo", "round-start", "round-skipped", "game-paused", "game-state", "game-over"]);
// The event that starts each phase (its `duration` is the phase's full countdown), and the payloads that resync a
// phase with what is left of it plus that full countdown as `phaseTotal` (EXP-273)
const PHASE_START_EVENTS = { "waiting-photo": "waiting-photo", "round-start": "answering", "round-reveal": "reveal", "round-scores": "scores" };
const RESYNC_EVENTS = new Set(["game-state", "game-resumed", "hold-resume"]);

/**
 * What is wrong with a resync payload's `phaseTotal`, or null: it is never less than `duration`, and it repeats the
 * `duration` of the phase's start event (`startDuration`, when this bot saw one) unless the countdown is shown whole
 * (`phaseTotal` = `duration`: ready phase, a round about to start after a boundary pause, game over).
 */
function phaseTotalProblem(ev, d, startDuration) {
  const { phase, duration, phaseTotal } = d ?? {};
  if (!Number.isFinite(phaseTotal) || !(phaseTotal >= duration)) return `${ev}: phaseTotal ${phaseTotal} with duration ${duration} (${phase})`;
  if (startDuration !== undefined && phaseTotal !== startDuration && phaseTotal !== duration) {
    return `${ev}: phaseTotal ${phaseTotal} for ${phase}, whose start event sent duration ${startDuration}`;
  }
  return null;
}
// Like the app rejoining from its lobby screen ("Join" after closing it): the first snapshot of a started game
// (and any your-turn with it) is missed while switching screens, then the join is re-sent on the same socket,
// which answers with a fresh game-state (and your-turn for an awaited photo)
const APP_RESYNC = !!args["app-resync"];
const LOBBY_HOST_DROP = !!args["lobby-host-drop"];
const PLAY_AGAIN_LINGER_S = Number(args["play-again-linger"] || 0);
const LINGER_BOT = Number(args["play-again-linger-bot"] || 1) - 1;
const START_NEXT_GAME_S = Number(args["start-next-game"] || 0); // K = 0: the bots start a 2nd game while a device lingers

// ── Quit at game-over, dropped by the next game (EXP-151) ──
const QUIT_AFTER_GAME_OVER = !!args["quit-after-game-over"];
const QUITTER = N_BOTS - 1; // the bot that quits with --quit-after-game-over
// The host starts the next game this long after the quitter became gone (DISCONNECT_GRACE_MS: the server's grace)
const GONE_START_MARGIN_MS = 3_000;
// --play-again-linger-bot 0: the bots stay in the lobby this long after the device's linger, so it finds them there
const LOBBY_STAY_AFTER_DEVICE_LINGER_MS = 15_000;
if (QUIT_AFTER_GAME_OVER) {
  if (!args.host) exitUsage("--quit-after-game-over needs --host (the host bot starts the next game)");
  if (N_BOTS < 3) exitUsage("--quit-after-game-over needs --bots 3 or more (2 must stay to play the next game)");
  if (PLAY_AGAIN_LINGER_S) exitUsage("use --quit-after-game-over or --play-again-linger, not both");
}
// Runs that play a second game after game-over, on the same sockets (its events are recorded as "g2-<event>")
const PLAYS_NEXT_GAME = PLAY_AGAIN_LINGER_S > 0 || QUIT_AFTER_GAME_OVER;

// ── Players out of the room (EXP-139) ──
/** --leave-round R / --leave-offline-round R: the round at whose round-start the last bot leaves (0: nobody leaves). */
function plannedLeaveRound(name) {
  const value = args[name];
  if (value === undefined) return 0;
  const rounds = parseRoundList(value);
  if (rounds?.length !== 1) exitUsage(`--${name} "${value}" is not a round number`);
  return withinHostedGame(`--${name}`, rounds[0]);
}
/** A planned exit at `round` must happen in the game: with --host the bots set its length (--rounds). */
function withinHostedGame(option, round) {
  if (args.host && round > ROUNDS) exitUsage(`${option}: round ${round} is beyond the game's ${ROUNDS} rounds (--rounds)`);
  return round;
}
// The retired mid-game form of --kick (NAME@R: at round R): the server ignores remove-player once a game started
const MID_GAME_KICK = /@[1-9][0-9]*$/;
/** --kick NAME -> NAME, removed in the lobby once it is in; null without --kick. */
function plannedKick() {
  const name = args.kick;
  if (name === undefined) return null;
  if (!args.host) exitUsage("--kick needs --host (only the host can remove a player)");
  if (N_ROOMS > 1) exitUsage("--kick takes a single room (bot names differ per room)");
  if (MID_GAME_KICK.test(name)) {
    exitUsage(`--kick "${name}": the host can only remove players in the lobby (EXP-316), there is no NAME@R form`);
  }
  if (!name || name.trim() !== name || name.length > MAX_USERNAME_LENGTH) {
    exitUsage(`--kick "${name}" is not a username (1-${MAX_USERNAME_LENGTH} characters, no surrounding spaces)`);
  }
  if (name === botName(0, 0)) exitUsage(`--kick "${name}": the host can't remove itself`);
  return name;
}
const LEAVE_ROUND = plannedLeaveRound("leave-round");
const LEAVE_OFFLINE_ROUND = plannedLeaveRound("leave-offline-round");
if (LEAVE_ROUND && LEAVE_OFFLINE_ROUND) exitUsage("use --leave-round or --leave-offline-round, not both (the same bot leaves)");
const LEAVER = N_BOTS - 1; // the bot that leaves with --leave-round or --leave-offline-round
// A pause lasts at least this long, as in Server/managers/GameEngine.ts (bots-cli.test.sh checks the copy)
const PAUSE_MIN_DURATION = 2_000;
// --leave-offline-round: offline this long before its leave, well past the minimum pause, so a rejoin first would
// resume a 2-player game paused for it at once (EXP-387)
const OFFLINE_LEAVE_AWAY_MS = 2 * PAUSE_MIN_DURATION;
const LEAVE_OWNER = !!args["leave-owner"]; // --leave-owner: round LEAVE_ROUND's photo owner leaves instead
if (LEAVE_OWNER && !LEAVE_ROUND) exitUsage("--leave-owner needs --leave-round");
// Like the app (Client/app/utils/leaveRoom.ts): the leaver closes its socket once leave-room is acked, or after this
const LEAVE_ACK_TIMEOUT_MS = 1_000;
// Like the app (Client/app/utils/plantPhotoAck.ts): a planted photo counts as sent only once plant-photo is acked ok
const PLANT_ACK_TIMEOUT_MS = 5_000;
// Like the app (Client/app/utils/startGame.ts): the host's start-game waits this long for its ack
const START_ACK_TIMEOUT_MS = 5_000;
// A lobby kick waits this long after NAME joined, like a host reading the list (and so a device's flow sees its lobby)
const LOBBY_KICK_DELAY_MS = 5_000;
const KICK_SETTLE_MS = 1_000; // after a kick that ends the run: time for the kicked player to get its notice
const KICK = plannedKick(); // --kick: the username the host bot removes in the lobby, or null
/** --kick-after-game D -> D, the seconds after game-over at which KICK is removed; 0 for a lobby kick. */
function plannedKickAfterGame() {
  const value = args["kick-after-game"];
  if (value === undefined) return 0;
  if (KICK === null) exitUsage("--kick-after-game needs --kick NAME (the player removed after the game)");
  const secs = Number(value);
  if (value.trim() === "" || !(Number.isFinite(secs) && secs > 0)) exitUsage(`--kick-after-game "${value}" is not a number of seconds above 0`);
  if (PLAYS_NEXT_GAME) exitUsage("--kick-after-game can't be combined with --play-again-linger or --quit-after-game-over (they play a second game)");
  return secs;
}
const KICK_AFTER_GAME_S = plannedKickAfterGame();
const LOBBY_KICK = KICK !== null && !KICK_AFTER_GAME_S; // --kick without --kick-after-game: removed before the game
// The server's answer to a join carrying the token of a player the host removed (Server/managers/RoomManager.ts)
const KICKED_REFUSAL = "Removed by host";
// What the room checks need to know about this run (qa/lab/bots-analysis.mjs)
const ANALYSIS_OPTS = {
  host: !!args.host, rounds: ROUNDS, playAgainLingerS: PLAY_AGAIN_LINGER_S, lingerBot: LINGER_BOT, startNextGameS: START_NEXT_GAME_S,
  quitAfterGameOver: QUIT_AFTER_GAME_OVER, answerRight: ANSWER_RIGHT,
};
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
    if (ev === "game-state") checkHidden(state.roundOptions ?? [], "game-state.roundOptions", state.phase);
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
      member: "UPLOAD_INFLIGHT_PER_MEMBER_MAX", room: "UPLOAD_INFLIGHT_PER_ROOM_MAX",
      ip: "UPLOAD_INFLIGHT_PER_IP_MAX / UPLOAD_INFLIGHT_PER_IP_BUSY_MAX (once the server is half full)",
      server: "UPLOAD_INFLIGHT_MAX",
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
    const spareSockets = []; // short-lived second connections of a bot (a holder rejoining on a new socket, --hold)
    const offlineLeave = { sentAt: null }; // --leave-offline-round: when the leaver's seat leave was sent
    /** --leave-offline-round (EXP-387): every bot that left offline sent its seat leave and the server acked it. */
    const seatLeaveProblems = () => events.filter((e) => e.ev === "left-room" && e.payload?.offline).flatMap(({ bot }) => {
      const sent = events.some((e) => e.bot === bot && e.ev === "seat-leave-sent");
      const answer = events.find((e) => e.bot === bot && e.ev === "seat-leave-done");
      if (!sent) return [`${bot}: left offline but never sent its seat leave`];
      return answer?.payload.acked ? [] : [`${bot}: its seat leave was ${answer ? "not acked" : "still waiting for its ack"} when the run ended`];
    });

    let ended = false;
    let deferredEnd = null; // the reason the run ended with while a seat leave was in flight (see leaveSeat)
    const done = (reason) => {
      if (ended) return;
      // --leave-offline-round: the others' game-over can arrive before the leaver's ack; that leave is answered first
      if (reason !== "timeout" && bots.some((b) => b.seatLeave)) { deferredEnd = reason; return; }
      ended = true;
      errors.push(...seatLeaveProblems());
      clearTimeout(timer);
      [...bots.map((b) => b.socket), ...spareSockets].forEach((s) => s.disconnect());
      resolve({ code, events, errors, uploads, rateLimited, reason, players: bots.map((b) => b.name) });
    };
    const timer = setTimeout(() => {
      errors.push(`timeout after ${TIMEOUT_S}s`);
      if (LOBBY_KICK && !kick.scheduled) errors.push(kickTargetMissing());
      done("timeout");
    }, TIMEOUT_S * 1000);

    // ── Voting for the owner (--answer-right, EXP-348) ──
    const roomBotNames = new Set(Array.from({ length: N_BOTS }, (_, i) => botName(roomIdx, i)));
    // round -> the bot of this run that sent its photo; forgotten when the round's photo is awaited again or skipped,
    // so a photo-sent the server ignored (or a previous game's round) never names a stale owner
    const photoSenders = new Map();
    /** Round's owner as far as this run can tell: the bot that sent its photo, else the only player that isn't ours. */
    const knownOwner = (bot) => {
      if (photoSenders.has(bot.round)) return photoSenders.get(bot.round);
      const others = [...bot.players, ...bot.leavers].filter((n) => !roomBotNames.has(n));
      return others.length === 1 ? others[0] : undefined;
    };

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
      const bot = { name, socket, isHost, players: [], leavers: [], guess: "", round: 0, token: null, plants: i < PLANT, droppedRounds: new Set() };
      bot.knownOwner = () => knownOwner(bot);
      bots.push(bot);
      // Second game (--play-again-linger-bot): recorded apart so the first game's checks only see the first game
      const rec = (ev, round, payload) =>
        events.push({ bot: name, ev: bot.game2 && ev !== "payload-leak" ? `g2-${ev}` : ev, round, t: now(), payload });
      bot.rec = rec;

      // rejoinToken (from our own room-of-game) is required by the server to reconnect with the same username
      const joinPayload = () => ({ gameCode: isHost && !code ? null : code, username: name, ...(bot.token ? { rejoinToken: bot.token } : {}) });
      const join = () => socket.emit("join-create-game", joinPayload());
      bot.join = join;
      socket.on("connect", () => {
        // --leave-offline-round: back from offline only to leave, naming the seat (never a rejoin)
        if (bot.seatLeave === "offline") { leaveSeat(); return; }
        // Out of the room for good (left or kicked): a reconnect planned before that (--chaos) must not come back
        if (bot.gone) { socket.disconnect(); return; }
        socketIds.add(socket.id);
        if (isHost || code) join();
      });
      // Privacy check of every received event. Runs before the event's own handler, so `phase` is the phase this
      // bot was in when it arrived; `baseline` = points per player at the last round-scores (null when unknown)
      // `askedRound`: round of the last your-turn since the last waiting-photo (only its round-skipped has a reason)
      const priv = { phase: null, baseline: null, askedRound: null };
      // `duration` of the last start event of each phase this bot saw: what a resync's phaseTotal must repeat
      const phaseStartDurations = new Map();
      socket.on("disconnect", () => { priv.baseline = null; }); // round-scores may be missed while away
      socket.onAny((ev, ...payload) => {
        const tokens = new Map(bots.map((b) => [b.name, b.token]));
        for (const leak of payloadLeaks(name, ev, payload, socketIds, tokens, priv)) rec("payload-leak", bot.round, { leak });
        if (ev === "round-skipped") {
          const leak = skipReasonLeak(payload[0], priv.askedRound);
          if (leak) rec("payload-leak", bot.round, { leak });
        }
        const d = payload[0];
        if (PHASE_START_EVENTS[ev]) phaseStartDurations.set(PHASE_START_EVENTS[ev], d?.duration);
        if (RESYNC_EVENTS.has(ev)) {
          const problem = phaseTotalProblem(ev, d, phaseStartDurations.get(d?.phase));
          if (problem) errors.push(`${name}: ${problem}`);
        }
        if (TURN_ENDING_EVENTS.has(ev)) bot.turn = null;
        if (ev === "your-turn") priv.askedRound = d?.round ?? null;
        else if (["waiting-photo", "game-state", "game-started", "game-over"].includes(ev)) priv.askedRound = null;
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
          else if (QUIT_AFTER_GAME_OVER) startNextGameOnceGone();
          // --play-again-linger-bot 0 --start-next-game D: the device is still on its final screens; start the next game
          else if (LINGER_BOT < 0 && START_NEXT_GAME_S && live.every((b) => b.playAgainDone)) {
            const host = live.find((b) => b.isHost);
            const wait = Math.max(300, START_NEXT_GAME_S * 1000 - (now() - (bot.gameOverAt ?? now())));
            setTimeout(() => startGame(host), wait);
          }
          // --play-again-linger-bot 0: a device lingers instead, so the bots stay (connected, in the lobby) a while
          // longer than it does, then end
          else if (live.every((b) => b.playAgainDone)) setTimeout(() => done("game-over"), LINGER_BOT < 0 ? PLAY_AGAIN_LINGER_S * 1000 + LOBBY_STAY_AFTER_DEVICE_LINGER_MS : 500);
          // A non-host still on the final screens: the host starts the next game once everyone else is back
          else if (lingerer && !lingerer.isHost && live.every((b) => b.playAgainDone || b === lingerer)) {
            const host = live.find((b) => b.isHost);
            setTimeout(() => startGame(host), 300);
          }
        }
        if (d.rejoinToken) bot.token = d.rejoinToken;
        // The room's game number (EXP-399): never behind the last game-started this bot saw
        if (!Number.isInteger(d.room.gameNumber) || d.room.gameNumber < (bot.gameNumber ?? 0)) {
          errors.push(`${name}: room-of-game game number ${d.room.gameNumber} behind game ${bot.gameNumber ?? 0}`);
        }
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
      // Someone left or was removed (like the app's game screen, DEC-038): out of the room, but during a round still one
      // of its options, and a pick on them stands, until the next waiting-photo; between rounds simply gone
      const dropPlayer = (username) => {
        if (!bot.players.includes(username)) return;
        bot.players = bot.players.filter((x) => x !== username);
        if (ROUND_PHASES.has(bot.phase)) bot.leavers.push(username);
        else if (bot.guess === username) bot.guess = pickGuess(bot);
      };
      socket.on("player-left", (n) => {
        rec("player-left", bot.round, { username: n });
        dropPlayer(n);
        if (votesForDepartedOwner(n)) { bot.guess = n; sendGuess(bot.round); }
      });
      // --leave-owner: the owner who left during its round stays the answer (DEC-038). The first bot still in the room
      // switches its pick to them at once, so the round always has a vote sent after the departure
      const votesForDepartedOwner = (username) => LEAVE_OWNER && bot.round === LEAVE_ROUND && bot.phase === "answering"
        && bot.leavers.includes(username) && bots.find((b) => !b.gone) === bot;
      // Removed by the host (EXP-139). If it is us, the server closes our connection next: we are out of the room
      socket.on("player-removed", (p) => {
        rec("player-removed", bot.round, { username: p.username });
        if (p.username === name) { bot.gone = true; bot.kicked = true; return; }
        dropPlayer(p.username);
        if (bot.isHost && p.username === KICK) onKickConfirmed();
      });
      socket.on("disconnect", (reason) => {
        if (bot.kicked && reason === "io server disconnect") {
          rec("kicked-out", bot.round, { reason });
          comeBackAfterKick();
        }
        // A bot that left offline is not out until its seat leave is answered (leaveSeat ends the run then)
        if ((bot.left && !bot.seatLeave) || bot.kicked) endIfAllOut();
      });
      // Like an app that was offline at the kick, missed player-removed and comes back with its stored token (EXP-337):
      // the server must refuse that join with its own reason, not let the kicked player in again as a new one
      const comeBackAfterKick = () => {
        const fresh = io(SERVER, { transports: ["websocket"], reconnection: false, forceNew: true });
        spareSockets.push(fresh);
        fresh.on("connect", () => fresh.emit("join-create-game", joinPayload()));
        fresh.on("connect_error", (e) => errors.push(`${name} rejoin after being kicked: connect_error ${e.message}`));
        fresh.on("room-of-game", (d) => {
          fresh.disconnect();
          if (d.success) errors.push(`${name}: let in again with its token after being kicked`);
          else if (d.message !== KICKED_REFUSAL) errors.push(`${name}: rejoin after being kicked refused with "${d.message}", not "${KICKED_REFUSAL}"`);
          else rec("kick-rejoin-refused", bot.round, { message: d.message });
        });
      };
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
          const ack = await socket.timeout(PLANT_ACK_TIMEOUT_MS)
            .emitWithAck("plant-photo", { photoUrl: up.url })
            .catch(() => null);
          if (!ack?.ok) {
            // A connection dropped meanwhile (--chaos, --drop-*) loses the ack: not a server fault
            if (ack || socket.connected) errors.push(`${name}: plant-photo not accepted (${ack ? ack.reason : "no ack"})`);
            return;
          }
          bot.plantedAt = now();
          rec("planted", 0);
          // Same-socket re-join (still in the lobby): its room-of-game must carry our own mark
          setTimeout(() => { if (!bot.inGame) join(); }, 100);
        } catch (e) {
          if (e.rateLimited) rateLimited++;
          errors.push(`${name} planted upload: ${e.message}`);
        }
      };
      socket.on("game-started", (players, rounds, gameNumber) => {
        if (PLAYS_NEXT_GAME && bot.playAgainDone !== undefined) bot.game2 = true;
        // The room's number of this game (EXP-318): bots-analysis checkGameNumbers compares the game's events with it
        if (!Number.isInteger(gameNumber) || gameNumber < 1) errors.push(`${name}: game-started without a positive integer game number`);
        bot.gameNumber = gameNumber;
        if (bot.lingering) {
          // Like the app's final screens (EXP-184): join the next game at once, the way "Play again" does: re-join on
          // the same socket (lobby hand-over); its game-state snapshot (ready phase) makes us send im-ready
          rec("game-started-while-lingering", 0, { gameNumber });
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
        rec("game-started", 0, { rounds, players: [...bot.players], gameNumber });
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
          bot.photoRound = d.round; // --leave-owner: this round's photo is ours
          photoSenders.set(d.round, name);
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
        bot.leavers = []; // a new round: its options are the players in the room
        const leaves = LEAVE_OWNER ? bot.photoRound === d.round : i === LEAVER;
        if (LEAVE_ROUND === d.round && leaves && !bot.gone) { leaveRoom(d.round); return; }
        if (LEAVE_OFFLINE_ROUND === d.round && i === LEAVER && !bot.gone) { leaveOffline(d.round); return; }
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
          setTimeout(() => { socket.connect(); }, randomBetween(CHAOS_AWAY_MS));
        }
        // Like a player tapping during the answer time (8 s): sometimes a first pick, then the final one
        const round = d.round;
        const decoy = pickGuess(bot);
        if (decoy && decoy !== bot.guess && Math.random() < 0.5) setTimeout(() => {
          if (bot.round === round && bot.phase === "answering" && socket.connected) socket.emit("submit-answer", { guess: decoy });
        }, 200 + Math.random() * 400);
        setTimeout(() => sendGuess(round), 800 + Math.random() * 1200);
      });
      // --leave-round (EXP-139): exactly like the app's Exit (GameContext.leaveRoom, EXP-254): leave-room, and close
      // the socket once the server acks it (or after LEAVE_ACK_TIMEOUT_MS); this bot is out of the game. A leave the
      // server never handles shows up as the others never getting player-left ("consistency")
      const leaveRoom = (round) => {
        bot.gone = true;
        bot.left = true;
        rec("left-room", round, LEAVE_OWNER ? { owner: true } : undefined);
        socket.timeout(LEAVE_ACK_TIMEOUT_MS).emit("leave-room", () => socket.disconnect());
      };
      // --leave-offline-round (EXP-387): like the app's Exit pressed while offline (GameContext.leaveRoom ->
      // leaveFromAnywhere): out of the game from the press; the socket comes back after OFFLINE_LEAVE_AWAY_MS and its
      // leave-room names the seat with the token, closing on the ack. The others must get player-left with no
      // game-resumed before it (see the game-resumed handler). bot.seatLeave: "offline" until the reconnection, "sent"
      // until the ack (or its cap); the run can't end "all-out" before that (see endIfAllOut), or the seat leave would
      // never be sent and the others would sit in the pause
      const leaveOffline = (round) => {
        bot.gone = true;
        bot.left = true;
        bot.seatLeave = "offline";
        rec("left-room", round, { offline: true });
        socket.disconnect();
        setTimeout(() => { socket.connect(); }, OFFLINE_LEAVE_AWAY_MS);
      };
      const leaveSeat = () => {
        bot.seatLeave = "sent";
        offlineLeave.sentAt = now();
        rec("seat-leave-sent", bot.round);
        const seat = { gameCode: code, username: name, rejoinToken: bot.token };
        socket.timeout(LEAVE_ACK_TIMEOUT_MS).emit("leave-room", seat, (err) => {
          bot.seatLeave = null;
          rec("seat-leave-done", bot.round, { acked: !err });
          socket.disconnect();
          if (deferredEnd) done(deferredEnd);
          else endIfAllOut();
        });
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
        // yourGuess: our own answer as the server froze it (null if missing, so the check reports it)
        rec("round-reveal", bot.round, { correctAnswer: d.correctAnswer, yourGuess: d.yourGuess ?? null });
        // Our photo: like the app, the scoreboard then shows us the hold button (--hold)
        bot.ownedRound = d.correctAnswer === name ? bot.round : 0;
        // Fair play: a vote sent once the answer is public must be ignored (checked against round-scores)
        if (i === 0 && d.correctAnswer) {
          socket.emit("submit-answer", { guess: d.correctAnswer });
          rec("late-submit", bot.round, { guess: d.correctAnswer });
        }
      });
      socket.on("round-scores", (d) => {
        bot.phase = "scores";
        bot.holdClosed = false; // a new scoreboard: holds are taken until its hold-closed
        rec("round-scores", d.round, { scores: d.scores });
        if (HOLD && bot.ownedRound === d.round && !bot.lingering && Math.random() < HOLD) pressHold(d.round);
      });
      socket.on("waiting-photo", (d) => {
        bot.phase = "waiting-photo";
        bot.leavers = []; // the round is over: those who left during it are no longer options
        photoSenders.delete(d.round);
        rec("waiting-photo", d.round, d);
      });
      socket.on("round-skipped", (d) => {
        photoSenders.delete(d?.round ?? bot.round);
        rec("round-skipped", d?.round ?? bot.round, d);
      });
      // Rejoin snapshot: catch up like the app does (pick again in answering, im-ready in the ready phase)
      socket.on("game-state", (d) => {
        rec("game-state", d.round, {
          phase: d.phase, paused: !!d.pause, pause: d.pause?.pause, maxPauses: d.pause?.maxPauses, started: d.started,
          gameNumber: d.gameNumber, // bots-analysis checkGameNumbers
          duration: d.duration, // a missed waiting-photo's remaining wait (bots-analysis isTimeoutSkip)
          yourGuess: d.yourGuess ?? null,
          holdsLeft: d.holdsLeft ?? null, // null if missing, so bots-analysis checkHoldsLeft reports it
        });
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
        // The round's options come from the server, those who left during it included (a player-left missed offline)
        bot.leavers = (d.roundOptions ?? []).map((p) => p.username).filter((n) => !bot.players.includes(n));
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
      socket.on("game-resumed", (d) => {
        rec("game-resumed", bot.round, { phase: d.phase });
        // --leave-offline-round (EXP-387): the leaver's seat is left, never rejoined, so its leave resumes nothing
        const leaver = botName(roomIdx, LEAVER);
        if (offlineLeave.sentAt !== null && bot.players.includes(leaver)) {
          errors.push(`${name}: game-resumed after ${leaver}'s offline leave, before its player-left`);
        }
      });
      // ── Holding the scoreboard (--hold, EXP-303) ──
      // bot.hold: our own press, from hold-start sent until it is over ({ round, accepted }). Like the app's greyed out
      // button, no press once the server said the scoreboard is too short for a hold (bot.holdClosed, EXP-354)
      const pressHold = (round) => setTimeout(() => {
        if (bot.phase !== "scores" || bot.round !== round || bot.holdClosed || !socket.connected) return;
        bot.hold = { round, accepted: false };
        rec("hold-sent", round);
        socket.emit("hold-start");
      }, randomBetween(HOLD_PRESS_DELAY_MS));
      socket.on("hold-start", () => {
        rec("hold-start", bot.round);
        const hold = bot.hold;
        // Someone else's hold (a device's), ours already running, or a press of an earlier round the server ignored
        if (!hold || hold.accepted || hold.round !== bot.round) return;
        hold.accepted = true; // the hold-start of our own press: we hold until we let go (or go away)
        rec("holding", hold.round);
        setTimeout(() => endHold(hold), randomBetween(HOLD_LENGTH_MS));
      });
      // Over for everyone: released, force-released (budget, a holder who went away) or ended by a pause
      socket.on("hold-end", (d) => {
        const holdsLeft = d?.holdsLeft ?? null; // null if missing, so the check reports it
        rec("hold-end", bot.round, { holdsLeft });
        // Our hold, still running on our side: the server ended it before we let go, which ends it for the checks too
        if (bot.hold?.accepted) rec("hold-ended-by-server", bot.hold.round);
        bot.hold = null;
        // Our scoreboard: like the app's button, press again while the server says holds are left (EXP-176)
        const ours = bot.ownedRound === bot.round && bot.phase === "scores" && !bot.lingering;
        if (HOLD && ours && holdsLeft > 0 && Math.random() < HOLD) pressHold(bot.round);
      });
      socket.on("hold-resume", (d) => rec("hold-resume", bot.round, d));
      // The running scoreboard is down to 1.5 s: no hold is accepted any more this round (EXP-354)
      socket.on("hold-closed", () => {
        rec("hold-closed", bot.round);
        bot.holdClosed = true;
      });
      // Let go, or (--chaos) go away while holding: drop, or rejoin on a new socket
      const endHold = (hold) => {
        if (bot.hold !== hold) return; // already over
        bot.hold = null;
        if (Math.random() >= CHAOS) {
          rec("hold-release-sent", hold.round);
          socket.emit("hold-end");
        } else if (Math.random() < 0.5) rejoinOnNewSocket(hold.round);
        else {
          rec("hold-drop", hold.round);
          socket.disconnect();
          setTimeout(() => { socket.connect(); }, randomBetween(CHAOS_AWAY_MS));
        }
      };
      // Like the app reconnecting before the server noticed its old connection was lost: the same player joins again
      // (rejoin token) on a fresh socket, and the server rebinds it there and closes this one. This bot then carries on
      // with its own socket: it reconnects and joins again, which closes the fresh one the same way
      const rejoinOnNewSocket = (round) => {
        const fresh = io(SERVER, { transports: ["websocket"], reconnection: false, forceNew: true });
        spareSockets.push(fresh);
        fresh.on("connect", () => {
          socketIds.add(fresh.id);
          socket.once("disconnect", () => socket.connect());
          rec("hold-rejoin", round);
          fresh.emit("join-create-game", joinPayload());
        });
        fresh.on("connect_error", (e) => errors.push(`${name} rejoin on a new socket: connect_error ${e.message}`));
      };
      socket.on("game-over", (d) => {
        rec("game-over", bot.round, { finalScore: d.finalScore });
        onGameOver();
      });
      // game-over, received or learnt from a rejoin snapshot
      const onGameOver = () => {
        bot.inGame = false;
        if (PLAYS_NEXT_GAME && !bot.gone) {
          if (bot.game2) {
            // The second game (started while someone lingered, or after the quitter was gone) ends the run
            bot.game2Over = true;
            if (bots.filter((b) => !b.gone).every((b) => b.game2Over)) setTimeout(() => done("game-over"), 500);
            return;
          }
          if (bot.playAgainDone !== undefined) return;
          if (QUIT_AFTER_GAME_OVER && i === QUITTER) { quitAfterGameOver(); return; }
          bot.playAgainDone = false;
          bot.gameOverAt = now();
          // The socket stays open on the final screens; Play again re-joins on it (the lingering bot after S seconds)
          bot.lingers = PLAY_AGAIN_LINGER_S > 0 && i === LINGER_BOT;
          bot.lingering = bot.lingers;
          bot.lingerTimer = setTimeout(() => { bot.lingering = false; bot.playAgainPending = true; join(); }, bot.lingers ? PLAY_AGAIN_LINGER_S * 1000 : 300);
          return;
        }
        // --kick-after-game: everyone stays on the final screens; whoever is host by then removes KICK, which ends the run
        if (KICK_AFTER_GAME_S) {
          scheduleKickAfterGame();
          return;
        }
        if (++finished === bots.filter((b) => !b.gone).length) done("game-over");
      };
      // --quit-after-game-over: like the app killed on the final screens, the socket just closes (no leave-room) and
      // never comes back; the next game's start must drop this player
      const quitAfterGameOver = () => {
        bot.gone = true;
        rec("quit-after-game-over", bot.round);
        socket.disconnect(); // manual disconnect: socket.io-client doesn't reconnect
        nextGame.quitAt = now();
        startNextGameOnceGone();
      };
      return bot;
    };

    // The host starts a game like the app does (EXP-379): start-game acked { ok: true } (after game-started), or a
    // refusal that says why. A connection dropped meanwhile (--chaos, --drop-*) loses the ack: not a server fault
    const startGame = async (host) => {
      if (!host) return;
      const ack = await host.socket.timeout(START_ACK_TIMEOUT_MS).emitWithAck("start-game").catch(() => null);
      host.rec("start-ack", host.round, ack ?? { ok: null });
      if (!ack?.ok && (ack || host.socket.connected)) {
        errors.push(`${host.name}: start-game not accepted (${ack ? ack.reason : "no ack"})`);
      }
    };

    // --kick (EXP-139): the host removes KICK once, in the lobby (before the game, or after it with --kick-after-game)
    const kick = { scheduled: false, confirmed: false };
    const kickTargetMissing = () => `--kick ${KICK} never joined the lobby`;
    const sendKick = (host) => {
      host.socket.emit("remove-player", { username: KICK });
      // Recorded at the host's last round (0 before the game): the rounds played before the kick are not "after" it
      events.push({ bot: host.name, ev: "kick-sent", round: host.round, t: now(), payload: { username: KICK } });
    };
    // --kick-after-game: D seconds after the first game-over a bot gets, the bot that is host at that moment (the role
    // may have moved, e.g. --lobby-host-drop) removes KICK, if KICK is still in the room
    const scheduleKickAfterGame = () => {
      if (kick.scheduled) return;
      kick.scheduled = true;
      setTimeout(() => {
        const host = bots.find((b) => b.isHost && !b.gone);
        if (host?.players.includes(KICK)) { sendKick(host); return; }
        errors.push(host ? `--kick ${KICK} was not in the room ${KICK_AFTER_GAME_S}s after game-over`
          : `--kick ${KICK}: no bot was host ${KICK_AFTER_GAME_S}s after game-over to remove it`);
        done("kick-target-missing");
      }, KICK_AFTER_GAME_S * 1000);
    };
    // The host got player-removed for KICK. A kick after the game, or a lobby kick that leaves nobody to play with (one
    // bot host and the kicked device, qa/maestro/kicked-notice.yaml), ends the run: a device checks its notice
    const onKickConfirmed = () => {
      kick.confirmed = true;
      if (KICK_AFTER_GAME_S) setTimeout(() => done("game-over"), KICK_SETTLE_MS);
      else if (WAIT_PLAYERS - 1 < 2) setTimeout(() => done("lobby-kick"), KICK_SETTLE_MS);
      else maybeStart();
    };
    // --quit-after-game-over (EXP-151): once the quitter is gone and every other bot is back in the lobby, the host
    // starts the next game when the quitter has been disconnected longer than the server's grace
    const nextGame = { quitAt: null, scheduled: false };
    const startNextGameOnceGone = () => {
      const live = bots.filter((b) => !b.gone);
      if (nextGame.scheduled || nextGame.quitAt === null || !live.every((b) => b.playAgainDone)) return;
      nextGame.scheduled = true;
      const host = live.find((b) => b.isHost);
      const wait = nextGame.quitAt + DISCONNECT_GRACE_MS + GONE_START_MARGIN_MS - now();
      setTimeout(() => startGame(host), Math.max(0, wait));
    };

    // Every bot of this process left (--leave-round / --leave-offline-round with real devices playing on) or was kicked (by another bots
    // process' host): nothing more for them to do
    const endIfAllOut = () => { if (bots.every((b) => b.gone)) done("all-out"); };

    const maybeStart = () => {
      const host = bots.find((b) => b.isHost);
      if (!host || started || !code) return;
      // Lobby kick: NAME goes LOBBY_KICK_DELAY_MS after it is in, and the game starts without it once the server
      // confirmed it
      if (LOBBY_KICK && !kick.confirmed) {
        // Everyone the host waits for is in, and NAME is not one of them (a wrong name): nobody to kick
        if (!kick.scheduled && !host.players.includes(KICK) && host.players.length >= WAIT_PLAYERS) {
          errors.push(kickTargetMissing());
          done("kick-target-missing");
          return;
        }
        if (!kick.scheduled && host.players.includes(KICK)) {
          kick.scheduled = true;
          setTimeout(() => sendKick(host), LOBBY_KICK_DELAY_MS);
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
        setTimeout(() => startGame(host), 500);
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
  || (KICK !== null && reason === "lobby-kick") || ((LEAVE_ROUND > 0 || LEAVE_OFFLINE_ROUND > 0) && reason === "all-out");
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
