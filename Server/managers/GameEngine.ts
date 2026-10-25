import { Server } from "socket.io";
import { GameStateSnapshot, PauseInfo, Player, Room, ScoreRound } from "../models/interfaces";
import { RoomManager } from "./RoomManager";

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const READY_TIMEOUT = 10_000; // After game-started, start the first round with whoever sent im-ready
const PHOTO_WAIT_TIMEOUT = 15_000;
const HOLD_SAFETY_TIMEOUT = 30_000;
const HOLD_MIN_REMAINING = 1_500; // Stop allowing hold when less than this remains
const MAX_CONSECUTIVE_SKIPS = 3; // End the game after this many photo timeouts in a row
export const PAUSE_TIMEOUT = 5 * 60_000; // Fewer than 2 connected: countdown of each pause before game over
export const MAX_PAUSES = 3; // Counted pauses per game; when another one would be needed the game ends
export const PAUSE_GRACE = 10_000; // A pause resumed sooner than this is refunded (doesn't count toward MAX_PAUSES)
export const MAX_TOTAL_PAUSES = 10; // Pauses per game counted or not, so quick flaps can't freeze a game forever
export const PAUSE_MIN_DURATION = 2_000; // A pause is never shorter than this (flapping connections)
const RESUME_MIN_REMAINING = 1_500; // A resumed phase gets at least this much time
const PHOTO_RESUME_MIN_REMAINING = 5_000; // ...and the photo owner at least this much to (re)send the photo

export class GameEngine {
  /** Pauses started in each room's current game, refunded or not (capped by MAX_TOTAL_PAUSES) */
  private totalPauses = new WeakMap<Room, number>();

  constructor(private io: Server, private roomManager: RoomManager) {}

  // ── Public API ───────────────────────────────────────

  startGame(room: Room): void {
    room.started = true;
    room.round = 0;
    room.currentPlayer = null;
    room.currentPhoto = null;
    room.plantedPhotosShown = 0;
    room._consecutiveSkips = 0;
    room._pauseCount = 0;
    this.totalPauses.set(room, 0);
    // "Play again" reuses the room: drop scores and answers from the previous game
    room.players.forEach((p) => { p.points = 0; p.lastGuess = ""; p.lastAnswerCorrect = false; });
    console.log(`[${room.gameCode}] Game started`);
    this.io.to(room.gameCode).emit("game-started", room.players.map((p) => this.roomManager.publicPlayer(p)), room.rounds);
    // Don't wait forever for a player who backgrounds the app or drops before GameScreen mounts
    this.setTimer(room, READY_TIMEOUT, () => {
      if (!room.started || room.phase !== null) return;
      const missing = room.players.filter((p) => !p.isReady).map((p) => p.username);
      console.log(`[${room.gameCode}] Ready timeout — starting without: ${missing.join(", ")}`);
      this.onAllPlayersReady(room);
    });
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

    room.round++;
    room.phase = "answering";
    room.currentPhoto = photo;
    room._consecutiveSkips = 0;
    console.log(`[${room.gameCode}] Round ${room.round}: photo from ${username}`);

    // Atomic event: photo + phase info in one message
    this.io.to(room.gameCode).emit("round-start", {
      photo,
      owner: username,
      round: room.round,
      duration: ANSWER_TIME,
    });

    this.setTimer(room, ANSWER_TIME, () => this.enterReveal(room));
  }

  recordAnswer(room: Room, username: string, guess: string): void {
    // Accept during "answering" AND "reveal" (client submits when reveal arrives)
    if (room.phase !== "answering" && room.phase !== "reveal") return;
    const player = room.players.find((p) => p.username === username);
    if (!player) return;
    // Only accept first answer per round (ignore duplicates)
    if (player.lastGuess !== "") return;
    const correct = room.currentPlayer?.username === guess;
    player.lastGuess = guess || "(no guess)";
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

    // Pause: clear the phase timer, save remaining time
    room.held = true;
    this.pauseTimer(room);

    console.log(`[${room.gameCode}] HOLD — paused "${room.phase}", ${this.getTimerRemaining(room)}ms left`);

    // Safety timeout
    room._holdSafetyTimer = setTimeout(() => {
      room._holdSafetyTimer = null;
      if (room.held) {
        console.log(`[${room.gameCode}] HOLD safety timeout — force release`);
        this.forceRelease(room);
      }
    }, HOLD_SAFETY_TIMEOUT);

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
   */
  onConnectionChange(room: Room): void {
    if (!room.started || room.phase === null) return;
    const connected = room.players.filter((p) => p.connected).length;
    if (connected >= 2) { this.resumeGame(room); return; }
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

  /** A player rejoined on a new socket: resume if they were awaited, then send them a state snapshot. */
  onPlayerRejoined(room: Room, player: Player): void {
    const wasPaused = room.paused;
    this.onConnectionChange(room);
    this.io.to(player.socketId).emit("game-state", this.snapshot(room));
    if (!room.started) return;
    // Resuming re-sends your-turn itself; otherwise the returning owner still has to send the photo
    if (!wasPaused && !room.paused && room.phase === "waiting-photo" && room.currentPlayer === player) {
      this.io.to(player.socketId).emit("your-turn", { round: room.round + 1 });
    }
  }

  snapshot(room: Room): GameStateSnapshot {
    const inRound = room.phase === "answering" || room.phase === "reveal" || room.phase === "scores";
    const shown = room.phase === "reveal" || room.phase === "scores";
    // Running timer: what is left of it; paused/held timer: the frozen remaining time
    const duration = room._timer ? Math.max(0, room._timerDuration - (Date.now() - room._timerStartedAt)) : room._timerDuration;
    // Guesses of the round in play are secret until round-scores (points already count a correct one).
    // In waiting-photo they are already reset by startRound.
    const hideGuesses = room.started && (room.phase === "answering" || room.phase === "reveal");
    const players = room.players.map((p) => {
      const pub = this.roomManager.publicPlayer(p);
      return hideGuesses ? { ...pub, ...this.hiddenGuess(p) } : pub;
    });
    const scores = this.buildScores(room).map((sc) => {
      const p = room.players.find((x) => x.username === sc.username)!;
      return hideGuesses ? { ...sc, ...this.hiddenGuess(p) } : sc;
    });
    if (hideGuesses) scores.sort((a, b) => b.points - a.points);
    return {
      started: room.started,
      phase: room.phase,
      round: room.round,
      totalRounds: room.rounds,
      owner: inRound ? room.currentPlayer?.username ?? null : null,
      photo: inRound ? room.currentPhoto : null,
      correctAnswer: shown ? room.currentPlayer?.username ?? null : null,
      duration: room.started ? duration : 0,
      held: room.held,
      pause: room.paused ? this.pauseInfo(room) : null,
      scores,
      players,
    };
  }

  private hiddenGuess(p: Player): { points: number; lastGuess: string; lastAnswerCorrect: boolean } {
    return { points: p.points - (p.lastAnswerCorrect ? 1 : 0), lastGuess: "", lastAnswerCorrect: false };
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
      room.held = false;
      if (room._holdSafetyTimer) { clearTimeout(room._holdSafetyTimer); room._holdSafetyTimer = null; }
      this.io.to(room.gameCode).emit("hold-end");
    } else if (room._timer) {
      this.pauseTimer(room);
    }
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

  private resumeGame(room: Room): void {
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
    const min = room.phase === "waiting-photo" && room.currentPlayer ? PHOTO_RESUME_MIN_REMAINING : RESUME_MIN_REMAINING;
    room._timerDuration = Math.max(min, room._timerDuration);
    console.log(`[${room.gameCode}] RESUMED "${room.phase}" with ${room._timerDuration}ms (${room._pauseCount}/${MAX_PAUSES} pauses counted)`);
    this.io.to(room.gameCode).emit("game-resumed", { phase: room.phase, duration: room._timerDuration });
    // A photo sent while paused was ignored: ask the owner again
    if (room.phase === "waiting-photo" && room.currentPlayer?.connected) {
      this.io.to(room.currentPlayer.socketId).emit("your-turn", { round: room.round + 1 });
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

  private startRound(room: Room): void {
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
      room.currentPlayer = planted;
      room.plantedPhotosShown++;
      room.round++;
      room.phase = "answering";
      room.currentPhoto = planted.plantedPhoto ?? null;
      room._consecutiveSkips = 0;

      console.log(`[${room.gameCode}] Round ${room.round}: planted photo from ${planted.username}`);

      this.io.to(room.gameCode).emit("round-start", {
        photo: planted.plantedPhoto,
        owner: planted.username,
        round: room.round,
        duration: ANSWER_TIME,
      });
      planted.plantedPhoto = undefined;

      this.setTimer(room, ANSWER_TIME, () => this.enterReveal(room));
    } else {
      const idx = Math.floor(Math.random() * connected.length);
      room.currentPlayer = connected[idx];
      room.phase = "waiting-photo";
      room.currentPhoto = null;

      console.log(`[${room.gameCode}] Waiting photo from ${room.currentPlayer.username}`);
      this.io.to(room.currentPlayer.socketId).emit("your-turn", { round: room.round + 1 });

      this.setTimer(room, PHOTO_WAIT_TIMEOUT, () => {
        if (room.phase === "waiting-photo") {
          console.log(`[${room.gameCode}] Photo timeout — skipping`);
          this.io.to(room.gameCode).emit("round-skipped");
          room._consecutiveSkips++;
          if (room._consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            console.log(`[${room.gameCode}] ${room._consecutiveSkips} rounds skipped in a row — ending game`);
            this.endGame(room);
            return;
          }
          this.startRound(room);
        }
      });
    }
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
    this.roomManager.clearAllTimers(room);
    room.started = false;
    room.phase = null;
    room.players.forEach((p) => { p.isReady = false; });
    this.io.to(room.gameCode).emit("game-over", { finalScore: this.buildScores(room) });
    // Unused planted photos belong to this game only (photos planted for the next one arrive after this)
    room.players.forEach((p) => { p.hasPlantedPhoto = false; p.plantedPhoto = undefined; });
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

  private doRelease(room: Room): void {
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

    const candidates = room.players.filter((p) => p.plantedPhoto);
    if (candidates.length === 0) {
      // Slot reserved but no planted photos left — skip, play normal round
      room.plantedSlots.delete(nextRound);
      return null;
    }

    room.plantedSlots.delete(nextRound);
    return candidates[Math.floor(Math.random() * candidates.length)];
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
