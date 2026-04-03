import { Server } from "socket.io";
import { Player, Room, ScoreRound } from "../models/interfaces";
import { RoomManager } from "./RoomManager";

const ANSWER_TIME = 8_000;
const REVEAL_TIME = 3_000;
const SCORE_DISPLAY_TIME = 5_000;
const GAME_START_DELAY = 1_000;
const PHOTO_WAIT_TIMEOUT = 15_000;
const HOLD_SAFETY_TIMEOUT = 30_000;
const HOLD_MIN_REMAINING = 1_500; // Stop allowing hold when less than this remains

export class GameEngine {
  constructor(private io: Server, private roomManager: RoomManager) {}

  // ── Public API ───────────────────────────────────────

  startGame(room: Room): void {
    room.started = true;
    room.round = 0;
    room.plantedPhotosShown = 0;
    console.log(`[${room.gameCode}] Game started`);
    this.io.to(room.gameCode).emit("game-started", room.players, room.rounds);
  }

  onAllPlayersReady(room: Room): void {
    room.round = 0;
    this.assignPlantedSlots(room);
    console.log(`[${room.gameCode}] All ready, planted slots: [${[...room.plantedSlots].join(",")}]`);
    this.setTimer(room, GAME_START_DELAY, () => this.startRound(room));
  }

  onPhotoReceived(room: Room, photo: string, username: string): void {
    if (room.phase !== "waiting-photo") return;

    room.round++;
    room.phase = "answering";
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
    if (room.held) return false;
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

  // ── Private: Phase transitions ───────────────────────

  private startRound(room: Room): void {
    if (room.players.length < 2) { this.endGame(room); return; }
    if (room.round >= room.rounds) { this.endGame(room); return; }

    room.held = false;
    // Reset answers for new round
    room.players.forEach((p) => { p.lastGuess = ""; p.lastAnswerCorrect = false; });

    const planted = this.pickPlantedPhoto(room);
    if (planted) {
      room.currentPlayer = planted;
      room.plantedPhotosShown++;
      room.round++;
      room.phase = "answering";

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
      const idx = Math.floor(Math.random() * room.players.length);
      room.currentPlayer = room.players[idx];
      room.phase = "waiting-photo";

      console.log(`[${room.gameCode}] Waiting photo from ${room.currentPlayer.username}`);
      this.io.to(room.currentPlayer.socketId).emit("your-turn", { round: room.round + 1 });

      this.setTimer(room, PHOTO_WAIT_TIMEOUT, () => {
        if (room.phase === "waiting-photo") {
          console.log(`[${room.gameCode}] Photo timeout — skipping`);
          this.io.to(room.gameCode).emit("round-skipped");
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
    this.io.to(room.gameCode).emit("game-over", { finalScore: this.buildScores(room) });
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
      if (room.phase === "reveal") this.enterScores(room);
      else if (room.phase === "scores") this.startRound(room);
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
