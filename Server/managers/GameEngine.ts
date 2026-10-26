import { Server } from "socket.io";
import {
  GameStateSnapshot, PauseInfo, Player, PlayerConnectionData, Room, RoundSkippedData, RoundStartData, ScoreRound, WaitingPhotoData, YourTurnData,
} from "../models/interfaces";
import { DISCONNECT_GRACE, RoomManager } from "./RoomManager";
import { uploadStore } from "../middlewares/uploadStore";

const ANSWER_TIME = 8_000;
// Clients are shown ANSWER_TIME minus this, while answers are taken until ANSWER_TIME: a tap at the very end of the
// bar still reaches the server in "answering" (latency margin)
export const ANSWER_GRACE = 300;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const READY_TIMEOUT = 10_000; // After game-started, start the first round with whoever sent im-ready
const PHOTO_WAIT_TIMEOUT = 15_000;
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
const PHOTO_RESUME_MIN_REMAINING = 5_000; // ...and the photo owner at least this much to (re)send the photo
// A planted round shows a normal photo wait first, as long as a real one: a past wait of this room (waiting-photo →
// photo-sent) with ±PLANTED_JITTER, or PLANTED_DELAY_MIN..MAX when the room has none yet
const PLANTED_DELAY_MIN = 1_000;
const PLANTED_DELAY_MAX = 3_000;
const PLANTED_JITTER = 0.15;
const PLANTED_DELAY_FLOOR = 500;
const WAIT_HISTORY_SIZE = 20; // real photo waits remembered per room
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
   * No photo comes (the planter left, or the photo expired during a long pause): the wait times out when the
   * countdown ends, like an absent owner's
   */
  noPhoto?: boolean;
}

export class GameEngine {
  /** Pauses started in each room's current game, refunded or not (capped by MAX_TOTAL_PAUSES) */
  private totalPauses = new WeakMap<Room, number>();
  /** Holds of the current round: round number, holds started, ms held so far, start of the active hold */
  private holdUsage = new WeakMap<Room, { round: number; count: number; usedMs: number; since: number | null }>();
  /**
   * Id of each room's current photo request (your-turn `attempt`): one per owner pick, never reused, so a
   * photo-unavailable for an earlier pick (same round number after a skip) can't skip the current one
   */
  private turnAttempts = new WeakMap<Room, number>();
  /**
   * Planted round whose photo wait is on screen (phase waiting-photo, no owner picked): its planter, photo and the
   * delay before its round-start. Nobody is told the round is planted.
   */
  private plantedWaits = new WeakMap<Room, PlantedWait>();
  /** How long this room's real photo waits took (ms, waiting-photo → accepted photo-sent), newest last */
  private waitHistory = new WeakMap<Room, number[]>();

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
    this.totalPauses.set(room, 0);
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

    this.recordWait(room);
    room.round++;
    room.phase = "answering";
    room.currentPhoto = photo;
    room._consecutiveSkips = 0;
    console.log(`[${room.gameCode}] Round ${room.round}: photo from ${username}`);

    this.emitRoundStart(room, room.currentPlayer, photo);

    this.setTimer(room, ANSWER_TIME, () => this.enterReveal(room));
  }

  /**
   * Atomic round-start (photo + phase info). The owner's name is secret until round-reveal: everyone gets the same
   * payload with `isOwner: false`, except the owner's socket, which gets `isOwner: true` (hold button, no self-vote).
   */
  private emitRoundStart(room: Room, owner: Player, photo: string): void {
    const data: Omit<RoundStartData, "isOwner"> = { photo, round: room.round, duration: ANSWER_TIME - ANSWER_GRACE };
    // Relies on a rejoin evicting/disconnecting the owner's replaced socket, so only owner.socketId is the owner's

    this.io.to(room.gameCode).except(owner.socketId).emit("round-start", { ...data, isOwner: false } satisfies RoundStartData);
    this.io.to(owner.socketId).emit("round-start", { ...data, isOwner: true } satisfies RoundStartData);
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
    if (room._timer) clearTimeout(room._timer);
    room._timer = null;
    room._timerCallback = null;
    console.log(`[${room.gameCode}] ${username} has no photo to send — skipping`);
    this.skipRound(room, "unavailable");
  }

  recordAnswer(room: Room, username: string, guess: string): void {
    // Only while answering: round-reveal broadcasts correctAnswer, so answers freeze when answering ends
    if (room.phase !== "answering") return;
    const player = room.players.find((p) => p.username === username);
    if (!player) return;
    // The owner knows the answer: their vote is never recorded nor scored
    if (player === room.currentPlayer) return;
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
    if (!room.started) { this.reviewLobby(room); return; }
    if (room.phase === null) return;
    const connected = room.players.filter((p) => p.connected).length;
    if (connected >= 2) { this.resumeGame(room, rejoined); return; }
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
   * rejoin causes leaves the rejoiner's your-turn to this method, which sends it after the snapshot.
   */
  onPlayerRejoined(room: Room, player: Player): void {
    this.onConnectionChange(room, player);
    this.io.to(player.socketId).emit("game-state", this.snapshot(room, player));
    this.sendAwaitedTurn(room, player);
  }

  /**
   * A player's live socket asked to join its own started game again (the app's lobby screen received the rejoin
   * snapshot and handed over to the game screen): send the snapshot again, and your-turn if their photo is awaited.
   */
  resendState(room: Room, player: Player): void {
    if (!room.started) return;
    this.io.to(player.socketId).emit("game-state", this.snapshot(room, player));
    this.sendAwaitedTurn(room, player);
  }

  /** your-turn to `player` if the running (not paused) game awaits their photo. */
  private sendAwaitedTurn(room: Room, player: Player): void {
    if (room.started && !room.paused && room.phase === "waiting-photo" && room.currentPlayer === player) {
      this.io.to(player.socketId).emit("your-turn", this.yourTurn(room));
    }
  }

  /** `game-state` for `recipient`: only the owner's own snapshot says it is their photo (`isOwner`). */
  snapshot(room: Room, recipient?: Player): GameStateSnapshot {
    const inRound = room.phase === "answering" || room.phase === "reveal" || room.phase === "scores";
    const shown = room.phase === "reveal" || room.phase === "scores";
    // Running timer: what is left of it; paused/held timer: the frozen remaining time
    const duration = room._timer ? Math.max(0, room._timerDuration - (Date.now() - room._timerStartedAt)) : room._timerDuration;
    // Guesses of the round in play are secret until round-scores (points already count a correct one)
    const hideGuesses = this.roomManager.guessesHidden(room);
    const players = this.roomManager.publicPlayers(room);
    const scores = this.buildScores(room).map((sc) => {
      const p = room.players.find((x) => x.username === sc.username)!;
      return hideGuesses ? { ...sc, ...this.roomManager.hiddenGuess(p) } : sc;
    });
    if (hideGuesses) scores.sort((a, b) => b.points - a.points);
    return {
      started: room.started,
      phase: room.phase,
      round: room.round,
      totalRounds: room.rounds,
      isOwner: inRound && !!recipient && room.currentPlayer === recipient,
      photo: inRound ? room.currentPhoto : null,
      correctAnswer: shown ? room.currentPlayer?.username ?? null : null,
      duration: room.started ? this.clientDuration(room, duration) : 0,
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
    const total = this.totalPauses.get(room) ?? 0;
    if (room._pauseCount >= MAX_PAUSES || total >= MAX_TOTAL_PAUSES) {
      console.log(`[${room.gameCode}] Pauses used up (${room._pauseCount}/${MAX_PAUSES} counted, ${total}/${MAX_TOTAL_PAUSES} in all) — ending game`);
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
    room.paused = true;
    // Counted up front (the payload shows the would-be number); resumeGame refunds it if the pause was short
    room._pauseCount++;
    this.totalPauses.set(room, total + 1);
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
      // Planted photo wait: the countdown goes on from where the pause froze it (what the snapshot showed); the photo
      // arrives after a fresh upload-like delay, as a resumed owner re-sends theirs, never after the countdown
      room._timerDuration = wait.noPhoto ? Math.max(100, wait.shown)
        : Math.min(Math.max(room._timerDuration, this.plantedDelay(room)), Math.max(100, wait.shown - 100));
      wait.shownSince = Date.now();
    } else {
      const min = room.phase === "waiting-photo" && room.currentPlayer ? PHOTO_RESUME_MIN_REMAINING : RESUME_MIN_REMAINING;
      room._timerDuration = Math.max(min, room._timerDuration);
    }
    console.log(`[${room.gameCode}] RESUMED "${room.phase}" with ${room._timerDuration}ms (${room._pauseCount}/${MAX_PAUSES} pauses counted)`);
    this.io.to(room.gameCode).emit("game-resumed", { phase: room.phase, duration: this.clientDuration(room, room._timerDuration) });
    // A photo sent while paused was ignored: ask the owner again
    if (room.phase === "waiting-photo" && room.currentPlayer?.connected && room.currentPlayer !== rejoined) {
      this.io.to(room.currentPlayer.socketId).emit("your-turn", this.yourTurn(room));
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

  // ── Private: Phase transitions ───────────────────────

  /**
   * Next round: a planted photo, or a connected player picked to send one (`waiting-photo` to the room, then
   * `your-turn` to that player). `exclude` (the owner who just reported photo-unavailable) is not picked again
   * for this round when someone else can be.
   */
  private startRound(room: Room, exclude?: Player): void {
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
      room.phase = "waiting-photo";
      room.currentPhoto = null;
      const delay = this.plantedDelay(room);
      this.plantedWaits.set(room, { planter: planted, photo, shown: PHOTO_WAIT_TIMEOUT, shownSince: Date.now() });

      console.log(`[${room.gameCode}] Planted photo from ${planted.username} in ${delay}ms`);
      const waiting: WaitingPhotoData = { round: room.round + 1, duration: PHOTO_WAIT_TIMEOUT };
      this.io.to(room.gameCode).emit("waiting-photo", waiting);

      this.setTimer(room, delay, () => this.startPlantedRound(room));
    } else {
      const others = connected.filter((p) => p !== exclude);
      const candidates = others.length > 0 ? others : connected;
      room.currentPlayer = candidates[Math.floor(Math.random() * candidates.length)];
      room.phase = "waiting-photo";
      room.currentPhoto = null;
      this.plantedWaits.delete(room);
      this.turnAttempts.set(room, (this.turnAttempts.get(room) ?? 0) + 1); // new photo request

      console.log(`[${room.gameCode}] Waiting photo from ${room.currentPlayer.username}`);
      // Room-wide (owner included, same payload): everyone shows the wait, nobody learns whose turn it is
      const waiting: WaitingPhotoData = { round: room.round + 1, duration: PHOTO_WAIT_TIMEOUT };
      this.io.to(room.gameCode).emit("waiting-photo", waiting);
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
   * End of a planted round's hidden delay: its round-start or, if the planter left or the photo would expire before
   * the reveal is over (the wait may have been paused for minutes), a timeout like any owner's.
   */
  private startPlantedRound(room: Room): void {
    const wait = this.plantedWait(room);
    if (!wait) return;
    const planterGone = !room.players.includes(wait.planter);
    if (planterGone || !uploadStore.isLive(wait.photo, ANSWER_TIME + REVEAL_TIME)) {
      if (!planterGone) {
        console.log(`[${room.gameCode}] Planted photo from ${wait.planter.username} expired — round will time out`);
        uploadStore.remove(wait.photo);
      }
      // Like a normal owner who left: no photo comes, the wait runs out (15 s from waiting-photo) and is skipped
      wait.noPhoto = true;
      this.setTimer(room, this.shownDuration(room)!, () => {
        this.plantedWaits.delete(room);
        if (room.phase === "waiting-photo") this.skipRound(room, "timeout");
      });
      return;
    }
    this.plantedWaits.delete(room);

    room.currentPlayer = wait.planter;
    room.plantedPhotosShown++;
    room.round++;
    room.phase = "answering";
    room.currentPhoto = wait.photo;
    room._consecutiveSkips = 0;

    console.log(`[${room.gameCode}] Round ${room.round}: planted photo from ${wait.planter.username}`);
    this.emitRoundStart(room, wait.planter, wait.photo);
    this.setTimer(room, ANSWER_TIME, () => this.enterReveal(room));
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

  /** How long until a planted photo appears: a random past real wait of this room with jitter, else 1-3 s. */
  private plantedDelay(room: Room): number {
    const history = this.waitHistory.get(room) ?? [];
    if (history.length === 0) {
      return PLANTED_DELAY_MIN + Math.floor(Math.random() * (PLANTED_DELAY_MAX - PLANTED_DELAY_MIN + 1));
    }
    const base = history[Math.floor(Math.random() * history.length)];
    const jittered = base * (1 + (Math.random() * 2 - 1) * PLANTED_JITTER);
    return Math.round(Math.min(PHOTO_WAIT_TIMEOUT - 1_000, Math.max(PLANTED_DELAY_FLOOR, jittered)));
  }

  /** A real photo arrived: remember how long its wait took (pauses excluded) for planted rounds to imitate. */
  private recordWait(room: Room): void {
    const remaining = room._timer ? room._timerDuration - (Date.now() - room._timerStartedAt) : room._timerDuration;
    const waited = Math.min(PHOTO_WAIT_TIMEOUT, Math.max(0, PHOTO_WAIT_TIMEOUT - remaining));
    const history = this.waitHistory.get(room) ?? [];
    history.push(waited);
    if (history.length > WAIT_HISTORY_SIZE) history.shift();
    this.waitHistory.set(room, history);
  }

  /**
   * A planted photo arrived after the planted rounds were drawn (the app's retry when its lobby upload failed, sent
   * after im-ready): give it a free later round so it is still played.
   */
  onLatePlantedPhoto(room: Room): void {
    if (!room.started || room.phase === null) return; // still drawn by onAllPlayersReady
    const planted = room.players.filter((p) => p.plantedPhoto).length;
    if (room.plantedSlots.size >= planted) return;
    const free: number[] = [];
    for (let r = room.round + 2; r <= room.rounds; r++) if (!room.plantedSlots.has(r)) free.push(r);
    if (free.length) room.plantedSlots.add(free[Math.floor(Math.random() * free.length)]);
  }

  /** The awaited photo won't be played: announce it, then the next round (same number) or game over. */
  private skipRound(room: Room, reason: RoundSkippedData["reason"]): void {
    const owner = room.currentPlayer ?? undefined;
    const skipped: RoundSkippedData = { round: room.round + 1, reason };
    this.io.to(room.gameCode).emit("round-skipped", skipped);
    room._consecutiveSkips++;
    if (room._consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
      console.log(`[${room.gameCode}] ${room._consecutiveSkips} rounds skipped in a row — ending game`);
      this.endGame(room);
      return;
    }
    this.startRound(room, reason === "unavailable" ? owner : undefined);
  }

  private enterReveal(room: Room): void {
    room.phase = "reveal";
    const answer = room.currentPlayer?.username ?? "";
    console.log(`[${room.gameCode}] Reveal: ${answer}`);

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

    // Atomic event: tells client which phase and how much time
    this.io.to(room.gameCode).emit("hold-resume", {
      phase: room.phase,
      duration: remaining,
    });

    this.resumeTimer(room);
  }

  // ── Private: Helpers ─────────────────────────────────

  private buildScores(room: Room): ScoreRound[] {
    return room.players
      .map((p) => ({ username: p.username, points: p.points, isHost: p.isHost, lastAnswerCorrect: p.lastAnswerCorrect, lastGuess: p.lastGuess }))
      .sort((a, b) => b.points - a.points);
  }

  /** Pick a planted photo if this round is a planted slot */
  private pickPlantedPhoto(room: Room): Player | null {
    // Next round number would be room.round + 1
    const nextRound = room.round + 1;
    if (!room.plantedSlots.has(nextRound)) return null;

    this.dropExpiredPlantedPhotos(room);
    const candidates = room.players.filter((p) => p.plantedPhoto);
    if (candidates.length === 0) {
      // Slot reserved but no planted photos left — skip, play normal round
      room.plantedSlots.delete(nextRound);
      return null;
    }

    room.plantedSlots.delete(nextRound);
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
