export interface Player {
  username: string;
  points: number;
  socketId: string;
  isHost: boolean;
  isReady: boolean;
  /** False while the player's socket is disconnected (kept in the room so they can rejoin) */
  connected: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
  hasPlantedPhoto?: boolean;
  plantedPhoto?: string;
  /** Secret returned only to this player's socket; required to rejoin with this username. Never broadcast. */
  rejoinToken: string;
}

/** Player as sent to other clients (no rejoin token, no planted photo URL). */
export type PublicPlayer = Omit<Player, "rejoinToken" | "plantedPhoto">;

export interface ScoreRound {
  username: string;
  points: number;
  isHost: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
}

export interface PlayerId {
  username: string;
  gameCode: string;
}

export type RoundPhase = "waiting-photo" | "answering" | "reveal" | "scores";

export interface Room {
  gameCode: string;
  players: Player[];
  rounds: number;
  started: boolean;
  currentPlayer: Player | null;
  round: number;
  plantedPhotosShown: number;
  /** Round numbers where planted photos will appear (decided at game start) */
  plantedSlots: Set<number>;
  phase: RoundPhase | null;
  /** Photo path shown in the current round (answering/reveal/scores), for resync snapshots */
  currentPhoto: string | null;
  /** Fewer than 2 players connected mid-game: phase timer frozen until someone returns or the pause expires */
  paused: boolean;
  _pauseTimer: NodeJS.Timeout | null;
  _pauseStartedAt: number;
  /** Pause time already spent in this game (the budget is PAUSE_TIMEOUT per game, not per pause) */
  _pauseUsed: number;
  /** Resume scheduled for when the pause reaches its minimum length */
  _resumeTimer: NodeJS.Timeout | null;
  /** Usernames the current pause is waiting for (as last announced) */
  _pauseWaitingFor: string[];
  /** Rounds skipped in a row (photo timeout); reset when a round is actually played */
  _consecutiveSkips: number;
  /** A second player joined at some point (abandoned solo rooms are cleaned up sooner) */
  _hadGuests: boolean;

  // Timer: only ONE active timer at a time
  _timer: NodeJS.Timeout | null;
  _timerCallback: (() => void) | null;
  _timerStartedAt: number;
  _timerDuration: number;

  // Hold
  held: boolean;
  _holdSafetyTimer: NodeJS.Timeout | null;
}

export interface JoinCreateGameData {
  gameCode: string | null;
  username: string;
  /** Token from a previous room-of-game; required to rejoin with an existing username */
  rejoinToken?: string;
}

export type SafeRoom = Omit<Room, "_timer" | "_timerCallback" | "_timerStartedAt" | "_timerDuration" | "_holdSafetyTimer" | "_pauseTimer" | "_pauseStartedAt" | "_pauseUsed" | "_resumeTimer" | "_pauseWaitingFor" | "plantedSlots" | "_consecutiveSkips" | "_hadGuests" | "players" | "currentPlayer"> & {
  players: PublicPlayer[];
  currentPlayer: PublicPlayer | null;
};

export interface RoomOfGameResponse {
  success: boolean;
  room?: SafeRoom;
  message?: string;
  rounds?: number;
  /** Only in the response to the joining socket itself */
  rejoinToken?: string;
}

/**
 * `game-state`: sent only to a player who rejoins, so a reconnecting client can render the current phase.
 * `duration` is the remaining time of the current phase (frozen while paused or held).
 */
export interface GameStateSnapshot {
  started: boolean;
  phase: RoundPhase | null;
  round: number;
  totalRounds: number;
  /** Photo owner; null while waiting for a photo (it is secret until round-start) */
  owner: string | null;
  /** Photo path, only in answering/reveal/scores */
  photo: string | null;
  /** Only in reveal/scores */
  correctAnswer: string | null;
  duration: number;
  held: boolean;
  /** Remaining pause countdown and who the game is waiting for, or null when not paused */
  pause: { duration: number; waitingFor: string[] } | null;
  scores: ScoreRound[];
  players: PublicPlayer[];
}
