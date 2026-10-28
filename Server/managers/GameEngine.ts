import { Server } from "socket.io";
import {
  GameStateSnapshot, PauseInfo, PhaseResumeData, Player, PlayerConnectionData, Room, RoundPhase, RoundSkippedData, RoundStartData, ScoreRound, WaitingPhotoData, YourTurnData,
} from "../models/interfaces";
import { DISCONNECT_GRACE, RoomManager } from "./RoomManager";
import { uploadStore } from "../middlewares/uploadStore";
import { drawPlantedDelay, PhotoWaitHistory } from "./plantedDelay";

const ANSWER_TIME = 8_000;
// Clients are shown ANSWER_TIME minus this, while answers are taken until ANSWER_TIME: a tap at the very end of the
// bar still reaches the server in "answering" (latency margin)
export const ANSWER_GRACE = 300;
const SHOWN_ANSWER_TIME = ANSWER_TIME - ANSWER_GRACE;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const READY_TIMEOUT = 10_000; // After game-started, start the first round with whoever sent im-ready
const PHOTO_WAIT_TIMEOUT = 15_000;
// Countdown clients get when each phase starts (the `duration` of waiting-photo / round-start / round-reveal /
// round-scores); resync payloads repeat it as `phaseTotal`, so a client that missed the start resumes its bar right
const PHASE_TOTAL: Record<RoundPhase, number> = {
  "waiting-photo": PHOTO_WAIT_TIMEOUT,
  answering: SHOWN_ANSWER_TIME,
  reveal: REVEAL_TIME,
  scores: SCORE_DISPLAY_TIME,
};
// The photo owner may hold the scores screen at most MAX_HOLDS_PER_ROUND times per round, HOLD_BUDGET_PER_ROUND in
// total (a hold that outlasts what is left of the budget is force-released)
export const MAX_HOLDS_PER_ROUND = 3;
export const HOLD_BUDGET_PER_ROUND = 30_000;
const HOLD_MIN_REMAINING = 1_500; // Stop allowing hold when less than this remains
const MAX_CONSECUTIVE_SKIPS = 3; // End the game after this many photo timeouts in a row
export const PAUSE_TIMEOUT = 5 * 60_000; // Fewer than 2 connected: countdown of each pause before game over
export const MAX_PAUSES = 3; // Counted pauses per game; when another one would be needed the game ends
export const PAUSE_GRACE = 10_000; // A pause resumed sooner than this is refunded (doesn't count toward MAX_PAUSES)
export const MAX_TOTAL_PAUSES = 10; // Pauses per game counted or not, so quick flaps can't freeze a game forever
export const PAUSE_MIN_DURATION = 2_000; // A pause is never shorter than this (flapping connections)
const RESUME_MIN_REMAINING = 1_500; // A resumed phase gets at least this much time
// ...and a photo wait, normal or planted alike, at least this much on its countdown (the owner can (re)send the photo)
const PHOTO_RESUME_MIN_REMAINING = 5_000;
// The awaited owner disconnected: another player is asked for the round's photo unless they are back within this (a
// brief flap goes unnoticed)
export const OWNER_RETURN_WINDOW = 3_000;
// Owner changes per player and game that don't count as a skip (the owner left, or was away for OWNER_RETURN_WINDOW).
// Beyond them that player gets no return window (the normal photo wait and its counted timeout) and leaving counts
// toward MAX_CONSECUTIVE_SKIPS, so players can't keep passing their turns on to steer every round onto someone
export const MAX_FREE_OWNER_CHANGES = 2;
// A planted round's hidden delay (see plantedDelay.ts) ends before its 15 s countdown by at least this
const PLANTED_DELAY_MARGIN = 1_000;
// After a resume, a planted photo comes at least this long later, like an owner re-sending a photo already uploaded
const PLANTED_RESEND_MIN = 100;
const PLANTED_RESEND_MAX = 400;
// A planted photo is only drawn if its upload outlives the round it would be shown in (the longest photo wait, then
// answering and reveal); one expiring sooner is dropped and the round is played with a normal photo
const PLANTED_PHOTO_MIN_LIFETIME = PHOTO_WAIT_TIMEOUT + ANSWER_TIME + REVEAL_TIME;

/**
 * A planted round's photo wait. `shown`/`shownSince` drive the countdown clients see: a normal 15 s photo wait,
 * frozen while paused (`shownSince` null), independent of the hidden real delay before round-start.
 */
interface PlantedWait {
  planter: Player;
  photo: string;
  shown: number;
  shownSince: number | null;
  /**
   * No photo comes (it expired during a long pause): the wait times out when the countdown ends, like that of an
   * owner who never sends
   */
  noPhoto?: boolean;
}

export class GameEngine {
  /** Holds of the current round: round number, holds started, ms held so far, start of the active hold */
  private holdUsage = new WeakMap<Room, { round: number; count: number; usedMs: number; since: number | null }>();
  /**
   * Id of each room's current photo request (your-turn `attempt`): one per waiting-photo (planted ones included),
   * never reused, so a photo-unavailable for an earlier pick (same round number after a skip) can't skip the current one
   */
  private turnAttempts = new WeakMap<Room, number>();
  /**
   * Planted round whose photo wait is on screen (phase waiting-photo, no owner picked): its planter, photo and the
   * delay before its round-start. Nobody is told the round is planted.
   */
  private plantedWaits = new WeakMap<Room, PlantedWait>();
  /** Each room's real photo waits per player (waiting-photo → accepted photo-sent), kept across its games */
  private waitHistories = new WeakMap<Room, PhotoWaitHistory>();
  /**
   * Each room's pending OWNER_RETURN_WINDOW: the photo request (your-turn `attempt`) whose disconnected owner it waits
   * for, and its timer
   */
  private ownerReturnWindows = new WeakMap<Room, { attempt: number; timer: NodeJS.Timeout }>();
  /** Players who went away as owner of each room's awaited round (see goneOwnersOf) */
  private goneOwners = new WeakMap<Room, { round: number; players: Set<Player> }>();
  /** Free owner changes used in each room's game, by username (see MAX_FREE_OWNER_CHANGES) */
  private freeOwnerChanges = new WeakMap<Room, Map<string, number>>();
  /**
   * Last phase broadcast to each room: phase, round (as clients see it) and server clock (QA telemetry `serverAt`).
   * `at` is undefined when that phase of that round was broadcast more than once (a skipped photo wait re-sends
   * waiting-photo with the same round): an ack can't tell which broadcast it answers.
   */
  private phaseEmits = new WeakMap<Room, { phase: RoundPhase; round: number; at: number | undefined }>();

  constructor(private io: Server, private roomManager: RoomManager) {}

  // ── Public API ───────────────────────────────────────

  /**
   * start-game. Every gone player (disconnected for longer than DISCONNECT_GRACE) is removed from the room first
   * (they come back as new players), so a "Play again" has no ghosts among the answers or the ranking. A player
   * reconnecting right now (within the grace) stays; if they don't return, the ready/pause logic handles them.
   * Refused (returns false) if fewer than 2 are left.
   */
  startGame(room: Room): boolean {
    this.removeDisconnected(room);
    if (room.players.length < 2) {
      console.log(`[${room.gameCode}] Start refused — fewer than 2 players after removing disconnected ones`);
      return false;
    }
    room.started = true;
    room.round = 0;
    room.currentPlayer = null;
    room.currentPhoto = null;
    room.plantedPhotosShown = 0;
    room._consecutiveSkips = 0;
    room._pauseCount = 0;
    room._totalPauses = 0;
    this.plantedWaits.delete(room);
    // "Play again" reuses the room: drop scores and answers from the previous game
    room.players.forEach((p) => { p.points = 0; p.lastGuess = ""; p.lastAnswerCorrect = false; });
    console.log(`[${room.gameCode}] Game started`);
    this.io.to(room.gameCode).emit("game-started", this.roomManager.publicPlayers(room), room.rounds);
    // Don't wait forever for a player who backgrounds the app or drops before GameScreen mounts
    this.setTimer(room, READY_TIMEOUT, () => {
      if (!room.started || room.phase !== null) return;
      const missing = room.players.filter((p) => !p.isReady).map((p) => p.username);
      console.log(`[${room.gameCode}] Ready timeout — starting without: ${missing.join(", ")}`);
      this.onAllPlayersReady(room);
    });
    return true;
  }

  /**
   * Server clock (ms) when `phase` of `round` was broadcast to `room`, until its next phase broadcast (dev/QA render
   * telemetry, Server/GAME_FLOW.md "QA render telemetry"); undefined for any other phase or round, and for one broadcast
   * more than once.
   */
  phaseEmittedAt(room: Room, phase: RoundPhase, round: number): number | undefined {
    const last = this.phaseEmits.get(room);
    return last && last.phase === phase && last.round === round ? last.at : undefined;
  }

  /** Game start: drop gone players like a leave (uploads released, host handed over, room notified). */
  private removeDisconnected(room: Room): void {
    if (room._lobbyTimer) { clearTimeout(room._lobbyTimer); room._lobbyTimer = null; }
    for (const ghost of room.players.filter((p) => this.roomManager.isGone(p))) {
      const result = this.roomManager.removePlayer(room.gameCode, ghost.username);
      if (!result.removed) continue;
      console.log(`[${room.gameCode}] ${ghost.username} removed at game start (disconnected)`);
      if (result.newHost) this.io.to(room.gameCode).emit("new-host", this.roomManager.publicPlayer(result.newHost, room));
      if (!result.isEmpty) this.io.to(room.gameCode).emit("player-left", ghost.username);
    }
    this.forgetLeaversWaits(room);
  }

  /** im-ready: only counts between game-started and the first round (phase is null until then). */
  markReady(room: Room, player: Player): void {
    if (!room.started || room.phase !== null) return;
    player.isReady = true;
    this.checkReady(room);
  }

  /**
   * Ready phase: start early once at least 2 players are connected and all of them are ready.
   * Call after im-ready and whenever a player disconnects, leaves or is kicked during the ready phase.
   * Otherwise READY_TIMEOUT decides (a lone player waits for the others to come back).
   */
  checkReady(room: Room): void {
    if (!room.started || room.phase !== null) return;
    // Disconnected players can't send im-ready; don't hold the others until the timeout for them
    const connected = room.players.filter((p) => p.connected);
    if (connected.length >= 2 && connected.every((p) => p.isReady)) this.onAllPlayersReady(room);
  }

  /** Leaves the ready phase and schedules the first round (replaces the ready timeout). */
  onAllPlayersReady(room: Room): void {
    room.phase = "waiting-photo"; // Out of the ready phase: later im-ready / ready timeout are no-ops
    room.round = 0;
    room.currentPlayer = null; // Picked by startRound; a stale owner from a previous game can't send a photo
    this.plantedWaits.delete(room);
    this.holdUsage.delete(room); // a new game: round numbers start over
    this.goneOwners.delete(room);
    this.freeOwnerChanges.delete(room);
    this.phaseEmits.delete(room);
    this.assignPlantedSlots(room);
    console.log(`[${room.gameCode}] All ready, planted slots: [${[...room.plantedSlots].join(",")}]`);
    this.setTimer(room, GAME_START_DELAY, () => this.startRound(room));
  }

  onPhotoReceived(room: Room, photo: string, username: string): void {
    if (room.phase !== "waiting-photo") return;
    // Paused: the owner gets your-turn again on resume and re-sends it
    if (room.paused) return;
    // Only the player whose turn it is may provide the photo
    if (room.currentPlayer?.username !== username) return;

    this.recordWait(room, room.currentPlayer);
    this.beginAnswering(room, room.currentPlayer, photo, "uploaded");
  }

  /**
   * Next round's answering phase with `owner`'s photo, uploaded or planted alike (nobody may tell them apart):
   * atomic round-start (photo + phase info), the same for the whole room. Whose photo it is stays secret until
   * round-reveal, also to the owner, who may not recognise it and guesses like everyone else (EXP-252).
   */
  private beginAnswering(room: Room, owner: Player, photo: string, source: "uploaded" | "planted"): void {
    room.currentPlayer = owner;
    room.round++;
    room.phase = "answering";
    room.currentPhoto = photo;
    room._consecutiveSkips = 0;
    console.log(`[${room.gameCode}] Round ${room.round}: ${source} photo from ${owner.username}`);

    this.markPhaseEmitted(room, room.round);
    const data: RoundStartData = { photo, round: room.round, duration: SHOWN_ANSWER_TIME };
    this.io.to(room.gameCode).emit("round-start", data);

    this.setTimer(room, ANSWER_TIME, () => this.enterReveal(room));
  }

  /**
   * Room-wide photo wait for the next round (owner or planter included, same payload): everyone shows the wait,
   * nobody learns whose turn it is or whether the round is planted.
   */
  private announcePhotoWait(room: Room): void {
    room.phase = "waiting-photo";
    this.roomManager.clearShownPhoto(room);
    this.turnAttempts.set(room, (this.turnAttempts.get(room) ?? 0) + 1); // new photo request, planted or not
    const waiting: WaitingPhotoData = { round: room.round + 1, duration: PHOTO_WAIT_TIMEOUT };
    this.markPhaseEmitted(room, waiting.round);
    this.io.to(room.gameCode).emit("waiting-photo", waiting);
  }

  /** Remembers that the room's current phase of `round` is being broadcast now (see phaseEmittedAt). */
  private markPhaseEmitted(room: Room, round: number): void {
    if (!room.phase) return;
    const last = this.phaseEmits.get(room);
    const repeated = last?.phase === room.phase && last.round === round;
    this.phaseEmits.set(room, { phase: room.phase, round, at: repeated ? undefined : Date.now() });
  }

  /** `your-turn` payload for the current photo request (re-sent unchanged on rejoin/resume). */
  private yourTurn(room: Room): YourTurnData {
    return { round: room.round + 1, attempt: this.turnAttempts.get(room) ?? 0 };
  }

  /**
   * photo-unavailable: the awaited owner can't provide a photo (no gallery access, no photos, upload failed).
   * Skips the round at once. Only from the current owner while waiting for their photo and not paused, and only
   * for the current request (`round` and `attempt` of its your-turn), so a late or duplicate report for an earlier
   * request is ignored. (The next attempt also goes to someone else when possible, see startRound's `exclude`.)
   */
  onPhotoUnavailable(room: Room, username: string, round: number, attempt: number): void {
    if (room.phase !== "waiting-photo" || room.paused) return;
    if (!room.currentPlayer || room.currentPlayer.username !== username) return;
    const current = this.yourTurn(room);
    if (round !== current.round || attempt !== current.attempt) return;
    this.clearPhaseTimer(room);
    console.log(`[${room.gameCode}] ${username} has no photo to send — skipping`);
    this.skipRound(room, "unavailable");
  }

  recordAnswer(room: Room, username: string, guess: string): void {
    // Only while answering: round-reveal broadcasts correctAnswer, so answers freeze when answering ends
    if (room.phase !== "answering") return;
    const player = room.players.find((p) => p.username === username);
    if (!player) return;
    // Only players still in the room are options (a player who left, the owner included, can't be voted for)
    if (guess !== "" && !room.players.some((p) => p.username === guess)) return;
    // The app sends its pick on every tap: the last one replaces the previous (and its point)
    if (player.lastAnswerCorrect) player.points--;
    const correct = guess !== "" && room.currentPlayer?.username === guess;
    player.lastGuess = guess; // "" = no guess (the client shows it translated)
    player.lastAnswerCorrect = correct;
    if (correct) player.points++;
  }

  // ── Hold ─────────────────────────────────────────────

  handleHold(room: Room, socketId: string): boolean {
    if (room.currentPlayer?.socketId !== socketId) return false;
    if (room.held || room.paused) return false;
    if (room.phase !== "scores") return false;

    // Don't allow hold if not enough time remaining
    const elapsed = Date.now() - room._timerStartedAt;
    const remaining = room._timerDuration - elapsed;
    if (remaining < HOLD_MIN_REMAINING) return false;

    // Hold limits of this round
    let usage = this.holdUsage.get(room);
    if (!usage || usage.round !== room.round) {
      usage = { round: room.round, count: 0, usedMs: 0, since: null };
      this.holdUsage.set(room, usage);
    }
    const budgetLeft = HOLD_BUDGET_PER_ROUND - usage.usedMs;
    if (usage.count >= MAX_HOLDS_PER_ROUND || budgetLeft < HOLD_MIN_REMAINING) return false;
    usage.count++;
    usage.since = Date.now();

    // Pause: clear the phase timer, save remaining time
    room.held = true;
    this.pauseTimer(room);

    console.log(`[${room.gameCode}] HOLD — paused "${room.phase}", ${this.getTimerRemaining(room)}ms left`);

    // Safety timeout: what is left of this round's hold budget
    room._holdSafetyTimer = setTimeout(() => {
      room._holdSafetyTimer = null;
      if (room.held) {
        console.log(`[${room.gameCode}] HOLD budget used up — force release`);
        this.forceRelease(room);
      }
    }, budgetLeft);

    return true;
  }

  handleRelease(room: Room, socketId: string): boolean {
    if (room.currentPlayer?.socketId !== socketId) return false;
    if (!room.held) return false;

    console.log(`[${room.gameCode}] HOLD released`);
    this.doRelease(room);
    return true;
  }

  forceRelease(room: Room): void {
    if (!room.held) return;
    console.log(`[${room.gameCode}] HOLD force-released`);
    this.doRelease(room);
    this.io.to(room.gameCode).emit("hold-end");
  }

  // ── Connection changes: pause / resume / resync ──────

  /**
   * Call after a player disconnects, rejoins, leaves or is removed. Mid-game (after the ready phase):
   * fewer than 2 connected → pause, or game over if nobody who is gone can come back (they all left);
   * 2 or more connected while paused → resume (not before PAUSE_MIN_DURATION). Ready phase: checkReady.
   * Lobby: reviewLobby. `rejoined`: the player whose rejoin this is (see onPlayerRejoined).
   */
  onConnectionChange(room: Room, rejoined?: Player): void {
    this.forgetLeaversWaits(room); // a leave or kick: a newcomer under the same name doesn't inherit their waits
    if (!room.started) { this.reviewLobby(room); return; }
    if (room.phase === null) return;
    const connected = room.players.filter((p) => p.connected).length;
    if (connected >= 2) {
      this.resumeGame(room, rejoined);
      // A rejoin reviews the owner after the rejoiner's snapshot (onPlayerRejoined)
      if (!rejoined) this.reviewAwaitedOwner(room);
      return;
    }
    if (room.players.length === connected) { this.endGame(room); return; } // nobody can come back
    if (!room.paused) { this.pauseGame(room); return; }
    // Still paused: a resume scheduled by a rejoin is off, and the others learn who is still missing
    if (room._resumeTimer) { clearTimeout(room._resumeTimer); room._resumeTimer = null; }
    const waitingFor = this.missingPlayers(room);
    if (waitingFor.join("\n") !== room._pauseWaitingFor.join("\n")) {
      room._pauseWaitingFor = waitingFor;
      this.io.to(room.gameCode).emit("game-paused", this.pauseInfo(room));
    }
  }

  /**
   * Lobby: announce players who are gone (disconnected > DISCONNECT_GRACE) or back (`player-connection`), hand a gone
   * host's role to the first connected player (`new-host`), and wake up again when the next grace runs out.
   * Short absences go unnoticed (DEC-009).
   */
  reviewLobby(room: Room): void {
    if (room._lobbyTimer) { clearTimeout(room._lobbyTimer); room._lobbyTimer = null; }
    if (room.started) return;
    const now = Date.now();
    const announce = (p: Player, connected: boolean) => {
      p.goneAnnounced = !connected;
      const data: PlayerConnectionData = { username: p.username, connected };
      this.io.to(room.gameCode).emit("player-connection", data);
    };
    for (const p of room.players) {
      if (p.connected && p.goneAnnounced) announce(p, true);
      else if (!p.goneAnnounced && this.roomManager.isGone(p, now)) announce(p, false);
    }
    const newHost = this.roomManager.handOverGoneHost(room);
    if (newHost) {
      console.log(`[${room.gameCode}] Host gone — ${newHost.username} is the new host`);
      this.io.to(room.gameCode).emit("new-host", this.roomManager.publicPlayer(newHost, room));
    }
    const pending = room.players
      .filter((p) => !p.connected && !this.roomManager.isGone(p, now))
      .map((p) => (p.disconnectedAt ?? now) + DISCONNECT_GRACE - now);
    if (pending.length) {
      room._lobbyTimer = setTimeout(() => { room._lobbyTimer = null; this.reviewLobby(room); }, Math.max(0, Math.min(...pending)));
    }
  }

  /**
   * A player rejoined on a new socket: resume if they were awaited, then send them a state snapshot, and your-turn
   * after it if their photo is awaited. The app drops a turn in flight on game-state (EXP-226), so a resume this
   * rejoin causes leaves the rejoiner's your-turn to this method, which sends it after the snapshot. The awaited owner
   * is reviewed last (a new owner's waiting-photo and your-turn also come after the snapshot).
   */
  onPlayerRejoined(room: Room, player: Player): void {
    this.onConnectionChange(room, player);
    this.io.to(player.socketId).emit("game-state", this.snapshot(room));
    this.sendAwaitedTurn(room, player);
    this.reviewAwaitedOwner(room);
  }

  /**
   * A player's live socket asked to join its own started game again (the app's lobby screen received the rejoin
   * snapshot and handed over to the game screen): send the snapshot again, and your-turn if their photo is awaited.
   */
  resendState(room: Room, player: Player): void {
    if (!room.started) return;
    this.io.to(player.socketId).emit("game-state", this.snapshot(room));
    this.sendAwaitedTurn(room, player);
  }

  /** your-turn to `player` if the running (not paused) game awaits their photo. */
  private sendAwaitedTurn(room: Room, player: Player): void {
    if (room.started && !room.paused && room.phase === "waiting-photo" && room.currentPlayer === player) {
      this.io.to(player.socketId).emit("your-turn", this.yourTurn(room));
    }
  }

  /** `game-state`, the same for every recipient: the owner is only named from the reveal on (`correctAnswer`). */
  snapshot(room: Room): GameStateSnapshot {
    const inRound = room.phase === "answering" || room.phase === "reveal" || room.phase === "scores";
    const shown = room.phase === "reveal" || room.phase === "scores";
    // Running timer: what is left of it; paused/held timer: the frozen remaining time
    const remaining = room._timer ? Math.max(0, room._timerDuration - (Date.now() - room._timerStartedAt)) : room._timerDuration;
    const { duration, phaseTotal } = room.started ? this.phaseTiming(room, remaining) : { duration: 0, phaseTotal: 0 };
    // Guesses of the round in play are secret until round-scores (points already count a correct one), also through
    // the scores' order (see buildScores)
    const scores = this.buildScores(room, this.roomManager.guessesHidden(room));
    const players = this.roomManager.publicPlayers(room);
    return {
      started: room.started,
      phase: room.phase,
      round: room.round,
      totalRounds: room.rounds,
      photo: inRound ? room.currentPhoto : null,
      correctAnswer: shown ? room.currentPlayer?.username ?? null : null,
      duration,
      phaseTotal,
      held: room.held,
      pause: room.paused ? this.pauseInfo(room) : null,
      scores,
      players,
    };
  }

  private pauseGame(room: Room): void {
    if (!room.started || room.paused) return;
    // Each pause gets the full PAUSE_TIMEOUT, but only MAX_PAUSES counted (and MAX_TOTAL_PAUSES in all) per game:
    // repeated drops can't keep a game frozen
    if (room._pauseCount >= MAX_PAUSES || room._totalPauses >= MAX_TOTAL_PAUSES) {
      console.log(`[${room.gameCode}] Pauses used up (${room._pauseCount}/${MAX_PAUSES} counted, ${room._totalPauses}/${MAX_TOTAL_PAUSES} in all) — ending game`);
      this.endGame(room);
      return;
    }
    if (room.held) {
      // The hold already froze the phase timer; the pause replaces it
      this.chargeHold(room);
      room.held = false;
      if (room._holdSafetyTimer) { clearTimeout(room._holdSafetyTimer); room._holdSafetyTimer = null; }
      this.io.to(room.gameCode).emit("hold-end");
    } else if (room._timer) {
      this.pauseTimer(room);
    }
    const wait = this.plantedWait(room);
    if (wait) { wait.shown = this.shownDuration(room)!; wait.shownSince = null; }
    this.cancelOwnerReturnWindow(room); // the resume reviews the owner again
    room.paused = true;
    // Counted up front (the payload shows the would-be number); resumeGame refunds it if the pause was short
    room._pauseCount++;
    room._totalPauses++;
    room._pauseStartedAt = Date.now();
    room._pauseTimer = setTimeout(() => {
      room._pauseTimer = null;
      if (!room.paused) return;
      console.log(`[${room.gameCode}] Nobody came back in time — ending game`);
      this.endGame(room);
    }, PAUSE_TIMEOUT);
    room._pauseWaitingFor = this.missingPlayers(room);
    console.log(`[${room.gameCode}] PAUSED "${room.phase}" (${room._timerDuration}ms left, pause ${room._pauseCount}/${MAX_PAUSES}), waiting for: ${room._pauseWaitingFor.join(", ")}`);
    this.io.to(room.gameCode).emit("game-paused", this.pauseInfo(room));
  }

  /** `rejoined`: a rejoining owner gets its your-turn from onPlayerRejoined, after its snapshot. */
  private resumeGame(room: Room, rejoined?: Player): void {
    if (!room.paused || room._resumeTimer) return;
    // A pause lasts at least PAUSE_MIN_DURATION, so a flapping connection can't spam pause/resume
    const early = PAUSE_MIN_DURATION - (Date.now() - room._pauseStartedAt);
    if (early > 0) {
      room._resumeTimer = setTimeout(() => { room._resumeTimer = null; this.onConnectionChange(room); }, early);
      return;
    }
    room.paused = false;
    room._pauseWaitingFor = [];
    if (room._pauseTimer) { clearTimeout(room._pauseTimer); room._pauseTimer = null; }
    // A short absence (back within PAUSE_GRACE) doesn't use up one of the game's MAX_PAUSES
    if (Date.now() - room._pauseStartedAt < PAUSE_GRACE) room._pauseCount--;
    const wait = this.plantedWait(room);
    if (wait) {
      // Planted photo wait: the countdown goes on from where the pause froze it, with the same minimum as a normal
      // one. The photo comes after what the pause left of the hidden delay, or a quick re-send at least (as a resumed
      // owner re-sends a photo already uploaded), always PLANTED_DELAY_MARGIN before the countdown ends
      wait.shown = Math.max(PHOTO_RESUME_MIN_REMAINING, wait.shown);
      room._timerDuration = wait.noPhoto ? wait.shown
        : Math.min(Math.max(room._timerDuration, this.resendDelay()), wait.shown - PLANTED_DELAY_MARGIN);
      wait.shownSince = Date.now();
    } else {
      const min = room.phase === "waiting-photo" && room.currentPlayer ? PHOTO_RESUME_MIN_REMAINING : RESUME_MIN_REMAINING;
      room._timerDuration = Math.max(min, room._timerDuration);
    }
    console.log(`[${room.gameCode}] RESUMED "${room.phase}" with ${room._timerDuration}ms (${room._pauseCount}/${MAX_PAUSES} pauses counted)`);
    const resumed: PhaseResumeData = { phase: room.phase, ...this.phaseTiming(room, room._timerDuration) };
    this.io.to(room.gameCode).emit("game-resumed", resumed);
    // A photo sent while paused was ignored: ask the owner again (unless they left: the owner review replaces them)
    const owner = room.currentPlayer;
    if (room.phase === "waiting-photo" && owner?.connected && room.players.includes(owner) && owner !== rejoined) {
      this.io.to(owner.socketId).emit("your-turn", this.yourTurn(room));
    }
    this.resumeTimer(room);
  }

  /**
   * `game-paused` payload / snapshot `pause`: countdown left of the pause in progress and which pause it is
   * (the would-be number: if the pause ends within PAUSE_GRACE it is refunded and the next one repeats it).
   */
  private pauseInfo(room: Room): PauseInfo {
    return {
      duration: Math.max(0, PAUSE_TIMEOUT - (Date.now() - room._pauseStartedAt)),
      waitingFor: this.missingPlayers(room),
      pause: room._pauseCount,
      maxPauses: MAX_PAUSES,
    };
  }

  private missingPlayers(room: Room): string[] {
    return room.players.filter((p) => !p.connected).map((p) => p.username);
  }

  /**
   * Running photo wait whose photo can't come (EXP-029, DEC-035): its owner (or a planted round's planter) left the
   * room, or a disconnected owner with free owner changes left isn't back within OWNER_RETURN_WINDOW. The owner is
   * replaced (see replaceGoneOwner). An owner without free changes left gets no window: the normal wait and its
   * counted timeout. A planted photo is already uploaded: its planter being disconnected changes nothing.
   */
  private reviewAwaitedOwner(room: Room): void {
    if (room.phase !== "waiting-photo" || room.paused) return;
    const planted = this.plantedWait(room);
    const owner = planted ? planted.planter : room.currentPlayer;
    if (!owner) return;
    if (!room.players.includes(owner)) {
      console.log(`[${room.gameCode}] ${owner.username} left while their photo was awaited`);
      this.replaceGoneOwner(room, owner);
    } else if (owner.connected) {
      this.cancelOwnerReturnWindow(room); // back in time: a later drop gets a whole window again
    } else if (!planted && this.freeOwnerChangesLeft(room, owner) > 0) {
      this.startOwnerReturnWindow(room, owner);
    }
  }

  /** The disconnected `owner` of the current photo request has OWNER_RETURN_WINDOW to come back (one window at a time). */
  private startOwnerReturnWindow(room: Room, owner: Player): void {
    const attempt = this.yourTurn(room).attempt;
    if (this.ownerReturnWindows.get(room)?.attempt === attempt) return;
    this.cancelOwnerReturnWindow(room);
    const timer = setTimeout(() => {
      this.ownerReturnWindows.delete(room);
      const sameRequest = room.started && room.phase === "waiting-photo" && room.currentPlayer === owner
        && this.yourTurn(room).attempt === attempt;
      if (!sameRequest || room.paused || owner.connected) return;
      console.log(`[${room.gameCode}] ${owner.username} didn't come back for their photo`);
      this.replaceGoneOwner(room, owner);
    }, OWNER_RETURN_WINDOW);
    this.ownerReturnWindows.set(room, { attempt, timer });
  }

  private cancelOwnerReturnWindow(room: Room): void {
    const window = this.ownerReturnWindows.get(room);
    if (!window) return;
    clearTimeout(window.timer);
    this.ownerReturnWindows.delete(room);
  }

  /**
   * The awaited `owner` is gone: the same round's photo is asked of another connected player who hasn't gone away
   * as its owner yet (the normal waiting-photo + your-turn, new attempt, no round-skipped). That uses one of the
   * owner's free owner changes, or counts toward MAX_CONSECUTIVE_SKIPS when they have none left. When nobody is left
   * to ask, the round is played again from scratch (round-skipped "timeout", same number), counted like any skip.
   */
  private replaceGoneOwner(room: Room, owner: Player): void {
    this.clearPhaseTimer(room);
    this.cancelOwnerReturnWindow(room);
    this.plantedWaits.delete(room);
    const gone = this.goneOwnersOf(room);
    gone.add(owner);
    if (!room.players.some((p) => p.connected && !gone.has(p))) {
      console.log(`[${room.gameCode}] Every player went away as owner of round ${room.round + 1} — playing it again`);
      gone.clear();
      this.skipRound(room, "timeout");
      return;
    }
    if (!this.takeFreeOwnerChange(room, owner) && this.countSkip(room)) return;
    console.log(`[${room.gameCode}] Asking another player for the round ${room.round + 1} photo`);
    this.startRound(room, gone);
  }

  private freeOwnerChangesLeft(room: Room, owner: Player): number {
    return MAX_FREE_OWNER_CHANGES - (this.freeOwnerChanges.get(room)?.get(owner.username) ?? 0);
  }

  /** Uses one of `owner`'s free owner changes of this game; false when none is left. */
  private takeFreeOwnerChange(room: Room, owner: Player): boolean {
    if (this.freeOwnerChangesLeft(room, owner) <= 0) return false;
    const used = this.freeOwnerChanges.get(room) ?? new Map<string, number>();
    used.set(owner.username, (used.get(owner.username) ?? 0) + 1);
    this.freeOwnerChanges.set(room, used);
    return true;
  }

  /** Players who went away as owner of the round now awaited (room.round + 1): not asked for its photo again. */
  private goneOwnersOf(room: Room): Set<Player> {
    const round = room.round + 1;
    let entry = this.goneOwners.get(room);
    if (entry?.round !== round) {
      entry = { round, players: new Set() };
      this.goneOwners.set(room, entry);
    }
    return entry.players;
  }

  // ── Private: Phase transitions ───────────────────────

  /**
   * Next round: a planted photo, or a connected player picked to send one (`waiting-photo` to the room, then
   * `your-turn` to that player). `exclude` (the owner who just reported photo-unavailable, or the owners who went
   * away) is not picked for this round when someone else can be.
   */
  private startRound(room: Room, exclude: ReadonlySet<Player> = new Set()): void {
    if (room.round >= room.rounds) { this.endGame(room); return; }
    // Reset answers for the new round (also before a boundary pause: the last ones were shown by round-scores)
    room.players.forEach((p) => { p.lastGuess = ""; p.lastAnswerCorrect = false; });
    // Only connected players can play; disconnected ones stay in the room to rejoin
    const connected = room.players.filter((p) => p.connected);
    if (connected.length < 2) {
      if (room.players.length === connected.length) { this.endGame(room); return; } // nobody can come back
      // Between rounds, no owner picked yet: wait for someone to return, then start this round
      room.phase = "waiting-photo";
      room.currentPlayer = null;
      room.currentPhoto = null;
      this.setTimer(room, GAME_START_DELAY, () => this.startRound(room));
      this.pauseGame(room);
      return;
    }

    room.held = false;

    const planted = this.pickPlantedPhoto(room);
    if (planted) {
      // Same visible sequence as an uploaded photo: room-wide waiting-photo, then round-start after an upload-like
      // delay. No owner is picked meanwhile (nobody gets your-turn, the planter can't send or skip a photo)
      const photo = planted.plantedPhoto ?? "";
      // Used now: never shown twice, and the planter's flag is gone
      planted.plantedPhoto = undefined;
      planted.hasPlantedPhoto = false;
      room.currentPlayer = null;
      const delay = this.plantedDelay(room, planted);
      this.plantedWaits.set(room, { planter: planted, photo, shown: PHOTO_WAIT_TIMEOUT, shownSince: Date.now() });

      console.log(`[${room.gameCode}] Planted photo from ${planted.username} in ${delay}ms`);
      this.announcePhotoWait(room);

      this.setTimer(room, delay, () => this.startPlantedRound(room));
    } else {
      const others = connected.filter((p) => !exclude.has(p));
      const candidates = others.length > 0 ? others : connected;
      room.currentPlayer = candidates[Math.floor(Math.random() * candidates.length)];
      this.plantedWaits.delete(room);
      console.log(`[${room.gameCode}] Waiting photo from ${room.currentPlayer.username}`);
      this.announcePhotoWait(room);
      this.io.to(room.currentPlayer.socketId).emit("your-turn", this.yourTurn(room));

      this.setTimer(room, PHOTO_WAIT_TIMEOUT, () => {
        if (room.phase === "waiting-photo") {
          console.log(`[${room.gameCode}] Photo timeout — skipping`);
          this.skipRound(room, "timeout");
        }
      });
    }
  }

  /**
   * End of a planted round's hidden delay: its round-start or, if the photo would expire before the reveal is over
   * (the wait may have been paused for minutes), a timeout like any owner's. (A planter who left was already replaced
   * by reviewAwaitedOwner.)
   */
  private startPlantedRound(room: Room): void {
    const wait = this.plantedWait(room);
    if (!wait) return;
    if (!uploadStore.isLive(wait.photo, ANSWER_TIME + REVEAL_TIME)) {
      console.log(`[${room.gameCode}] Planted photo from ${wait.planter.username} expired — round will time out`);
      uploadStore.remove(wait.photo);
      // Like an owner who never sends: no photo comes, the wait runs out (15 s from waiting-photo) and is skipped
      wait.noPhoto = true;
      this.setTimer(room, this.shownDuration(room)!, () => {
        this.plantedWaits.delete(room);
        if (room.phase === "waiting-photo") this.skipRound(room, "timeout");
      });
      return;
    }
    this.plantedWaits.delete(room);
    room.plantedPhotosShown++;
    this.beginAnswering(room, wait.planter, wait.photo, "planted");
  }

  /** The planted photo wait in progress, if any. */
  private plantedWait(room: Room): PlantedWait | undefined {
    return room.phase === "waiting-photo" ? this.plantedWaits.get(room) : undefined;
  }

  /**
   * Countdown sent to clients in a planted round's photo wait: what a normal 15 s wait would have left (frozen while
   * paused), never the hidden delay. Undefined outside a planted wait.
   */
  private shownDuration(room: Room): number | undefined {
    const wait = this.plantedWait(room);
    if (!wait) return undefined;
    return Math.max(0, wait.shown - (wait.shownSince === null ? 0 : Date.now() - wait.shownSince));
  }

  /**
   * Countdown sent to clients for a phase timer with `remaining` ms left: the planted wait's shown countdown, and in
   * answering ANSWER_GRACE less than the real timer (answers are still taken until it fires).
   */
  private clientDuration(room: Room, remaining: number): number {
    const planted = this.shownDuration(room);
    if (planted !== undefined) return planted;
    return room.phase === "answering" ? Math.max(0, remaining - ANSWER_GRACE) : remaining;
  }

  /**
   * Timing of a resync payload (`game-state`, `game-resumed`, `hold-resume`) for a phase timer with `remaining` ms
   * left: the countdown to show (`duration`) and `phaseTotal`, the full countdown the phase's start event sent, so a
   * client that never saw that start draws the bar from where the phase is. Before any start event (ready phase, a
   * round about to start after a boundary pause) the countdown is shown whole: `phaseTotal` = `duration`.
   */
  private phaseTiming(room: Room, remaining: number): { duration: number; phaseTotal: number } {
    const duration = this.clientDuration(room, remaining);
    const boundary = room.phase === "waiting-photo" && !room.currentPlayer && !this.plantedWait(room);
    return { duration, phaseTotal: room.phase && !boundary ? PHASE_TOTAL[room.phase] : duration };
  }

  /** How long until `planter`'s planted photo appears (see plantedDelay.ts): realistic, and like their own uploads. */
  private plantedDelay(room: Room, planter: Player): number {
    return drawPlantedDelay(this.waitHistoryOf(room).of(planter.username), PHOTO_WAIT_TIMEOUT - PLANTED_DELAY_MARGIN);
  }

  /** A resumed planted wait's quickest photo: a re-send of an already uploaded photo (PLANTED_RESEND_MIN..MAX). */
  private resendDelay(): number {
    return PLANTED_RESEND_MIN + Math.round(Math.random() * (PLANTED_RESEND_MAX - PLANTED_RESEND_MIN));
  }

  /** `owner`'s photo arrived: remember how long its wait took (pauses excluded) for their planted rounds to imitate. */
  private recordWait(room: Room, owner: Player): void {
    const remaining = room._timer ? room._timerDuration - (Date.now() - room._timerStartedAt) : room._timerDuration;
    const waited = Math.min(PHOTO_WAIT_TIMEOUT, Math.max(0, PHOTO_WAIT_TIMEOUT - remaining));
    this.waitHistoryOf(room).record(owner.username, waited);
  }

  /** The room's real photo waits, of the players still in it only. */
  private waitHistoryOf(room: Room): PhotoWaitHistory {
    let history = this.waitHistories.get(room);
    if (!history) {
      history = new PhotoWaitHistory();
      this.waitHistories.set(room, history);
    }
    this.forgetLeaversWaits(room);
    return history;
  }

  /** Drops the waits of players no longer in the room, as soon as they leave or are removed. */
  private forgetLeaversWaits(room: Room): void {
    this.waitHistories.get(room)?.keepOnly(room.players.map((p) => p.username));
  }

  /**
   * A planted photo arrived after the planted rounds were drawn (the app's retry when its lobby upload failed, sent
   * after im-ready): give it a free later round so it is still played.
   */
  onLatePlantedPhoto(room: Room): void {
    if (!room.started || room.phase === null) return; // still drawn by onAllPlayersReady
    this.reserveFreePlantedSlots(room);
  }

  /**
   * Reserves random free rounds after the next one as planted slots until there is one per unused planted photo
   * (or no free round is left).
   */
  private reserveFreePlantedSlots(room: Room): void {
    const planted = room.players.filter((p) => p.plantedPhoto).length;
    const free: number[] = [];
    for (let r = room.round + 2; r <= room.rounds; r++) if (!room.plantedSlots.has(r)) free.push(r);
    while (room.plantedSlots.size < planted && free.length > 0) {
      const [slot] = free.splice(Math.floor(Math.random() * free.length), 1);
      room.plantedSlots.add(slot);
    }
  }

  /**
   * The awaited photo won't be played: announce it, then the next round (same number) or game over.
   */
  private skipRound(room: Room, reason: RoundSkippedData["reason"]): void {
    const owner = room.currentPlayer ?? undefined;
    const skipped: RoundSkippedData = { round: room.round + 1, reason };
    this.io.to(room.gameCode).emit("round-skipped", skipped);
    if (this.countSkip(room)) return;
    this.startRound(room, new Set(reason === "unavailable" && owner ? [owner] : []));
  }

  /** One more photo wait lost in a row: true if that ends the game (MAX_CONSECUTIVE_SKIPS). */
  private countSkip(room: Room): boolean {
    room._consecutiveSkips++;
    if (room._consecutiveSkips < MAX_CONSECUTIVE_SKIPS) return false;
    console.log(`[${room.gameCode}] ${room._consecutiveSkips} rounds skipped in a row — ending game`);
    this.endGame(room);
    return true;
  }

  private enterReveal(room: Room): void {
    room.phase = "reveal";
    const answer = room.currentPlayer?.username ?? "";
    console.log(`[${room.gameCode}] Reveal: ${answer}`);
    this.markPhaseEmitted(room, room.round);

    this.io.to(room.gameCode).emit("round-reveal", {
      correctAnswer: answer,
      duration: REVEAL_TIME,
    });

    this.setTimer(room, REVEAL_TIME, () => this.enterScores(room));
  }

  private enterScores(room: Room): void {
    room.phase = "scores";
    const scores = this.buildScores(room);
    console.log(`[${room.gameCode}] Scores`);
    this.markPhaseEmitted(room, room.round);

    this.io.to(room.gameCode).emit("round-scores", {
      scores,
      round: room.round,
      totalRounds: room.rounds,
      duration: SCORE_DISPLAY_TIME,
    });

    this.setTimer(room, SCORE_DISPLAY_TIME, () => this.startRound(room));
  }

  private endGame(room: Room): void {
    console.log(`[${room.gameCode}] Game over`);
    // Ended before round-scores (abandoned, pauses used up): the unrevealed round's answers and points don't count
    if (this.roomManager.guessesHidden(room)) {
      room.players.forEach((p) => Object.assign(p, this.roomManager.hiddenGuess(p)));
    }
    this.roomManager.clearAllTimers(room);
    this.cancelOwnerReturnWindow(room);
    this.plantedWaits.delete(room);
    room.started = false;
    room.phase = null;
    room.players.forEach((p) => { p.isReady = false; });
    this.io.to(room.gameCode).emit("game-over", { finalScore: this.buildScores(room) });
    // Unused planted photos belong to this game only (photos planted for the next one arrive after this)
    room.players.forEach((p) => { p.hasPlantedPhoto = false; p.plantedPhoto = undefined; });
    room.currentPhoto = null;
    // Every photo of this game (played or planted) is deleted now, not at the 30-min expiry
    uploadStore.releaseRoom(room.gameCode);
    // Back in the lobby: whoever is gone is shown so, and a gone host hands the role over
    this.reviewLobby(room);
  }

  // ── Private: Timer (single timer per room) ───────────

  private setTimer(room: Room, ms: number, callback: () => void): void {
    if (room._timer) clearTimeout(room._timer);
    room._timerDuration = ms;
    room._timerStartedAt = Date.now();
    room._timerCallback = callback;
    room._timer = setTimeout(() => {
      room._timer = null;
      room._timerCallback = null;
      try { callback(); } catch (e) { console.error(`[${room.gameCode}] Timer error:`, e); }
    }, ms);
  }

  /** Drops the phase timer and its callback (the phase ends early). */
  private clearPhaseTimer(room: Room): void {
    if (room._timer) clearTimeout(room._timer);
    room._timer = null;
    room._timerCallback = null;
  }

  private pauseTimer(room: Room): void {
    if (room._timer) {
      clearTimeout(room._timer);
      room._timer = null;
    }
    // Calculate how much time was left
    const elapsed = Date.now() - room._timerStartedAt;
    room._timerDuration = Math.max(100, room._timerDuration - elapsed);
    // _timerCallback is preserved so we can resume
  }

  private resumeTimer(room: Room): void {
    const callback = room._timerCallback;
    if (!callback) {
      console.error(`[${room.gameCode}] Resume but no callback! Recovering...`);
      if (room.phase === "answering") this.enterReveal(room);
      else if (room.phase === "reveal") this.enterScores(room);
      else this.startRound(room);
      return;
    }

    room._timerStartedAt = Date.now();
    room._timer = setTimeout(() => {
      room._timer = null;
      room._timerCallback = null;
      try { callback(); } catch (e) { console.error(`[${room.gameCode}] Resume timer error:`, e); }
    }, room._timerDuration);
  }

  private getTimerRemaining(room: Room): number {
    return room._timerDuration;
  }

  /** The active hold ends: its time counts against the round's hold budget. */
  private chargeHold(room: Room): void {
    const usage = this.holdUsage.get(room);
    if (usage?.since == null) return;
    usage.usedMs += Date.now() - usage.since;
    usage.since = null;
  }

  private doRelease(room: Room): void {
    this.chargeHold(room);
    room.held = false;
    if (room._holdSafetyTimer) {
      clearTimeout(room._holdSafetyTimer);
      room._holdSafetyTimer = null;
    }

    // Ensure enough time for smooth transition after release
    const remaining = Math.max(HOLD_MIN_REMAINING, this.getTimerRemaining(room));
    room._timerDuration = remaining;
    console.log(`[${room.gameCode}] Resuming "${room.phase}" with ${remaining}ms`);

    // Atomic event: tells client which phase, how much time is left and the phase's full duration
    const resumed: PhaseResumeData = { phase: room.phase, ...this.phaseTiming(room, remaining) };
    this.io.to(room.gameCode).emit("hold-resume", resumed);

    this.resumeTimer(room);
  }

  // ── Private: Helpers ─────────────────────────────────

  /**
   * Scores, highest first; ties keep room order (stable sort over room.players). With `hideGuesses` the round's
   * answers are left out before sorting, so the order can't tell who guessed right (and so whose photo it is) either.
   */
  private buildScores(room: Room, hideGuesses = false): ScoreRound[] {
    return room.players
      .map((p) => {
        const row = { username: p.username, points: p.points, isHost: p.isHost, lastAnswerCorrect: p.lastAnswerCorrect, lastGuess: p.lastGuess };
        return hideGuesses ? { ...row, ...this.roomManager.hiddenGuess(p) } : row;
      })
      .sort((a, b) => b.points - a.points);
  }

  /**
   * The planter whose photo is shown next, if the next round is a planted slot. Only connected planters are drawn
   * (like owners of uploaded photos); with none, the slot is played as a normal round and a disconnected planter keeps
   * their photo, which gets a later free slot so it can still be shown once they are back.
   */
  private pickPlantedPhoto(room: Room): Player | null {
    const nextRound = room.round + 1;
    if (!room.plantedSlots.has(nextRound)) return null;
    room.plantedSlots.delete(nextRound);

    this.dropExpiredPlantedPhotos(room);
    const candidates = room.players.filter((p) => p.plantedPhoto && p.connected);
    if (candidates.length === 0) {
      this.reserveFreePlantedSlots(room);
      return null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /**
   * Drops planted photos whose upload is gone or expires before it could be shown (would load as a 404), deleting
   * the file right away if it is still stored.
   */
  private dropExpiredPlantedPhotos(room: Room): void {
    for (const p of room.players) {
      if (!p.plantedPhoto || uploadStore.isLive(p.plantedPhoto, PLANTED_PHOTO_MIN_LIFETIME)) continue;
      console.log(`[${room.gameCode}] Planted photo from ${p.username} expired — dropped`);
      uploadStore.remove(p.plantedPhoto);
      p.plantedPhoto = undefined;
      p.hasPlantedPhoto = false;
    }
  }

  /** Pre-assign random round slots for planted photos at game start */
  private assignPlantedSlots(room: Room): void {
    const plantedCount = room.players.filter((p) => p.plantedPhoto).length;
    if (plantedCount === 0) { room.plantedSlots = new Set(); return; }

    // Pick random unique round numbers from 1..rounds
    const allRounds: number[] = [];
    for (let i = 1; i <= room.rounds; i++) allRounds.push(i);

    // Shuffle and pick
    for (let i = allRounds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allRounds[i], allRounds[j]] = [allRounds[j], allRounds[i]];
    }

    room.plantedSlots = new Set(allRounds.slice(0, plantedCount));
  }
}
