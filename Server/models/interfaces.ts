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
  /** Rounds skipped in a row (photo timeout); reset when a round is actually played */
  _consecutiveSkips: number;

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

export type SafeRoom = Omit<Room, "_timer" | "_timerCallback" | "_timerStartedAt" | "_timerDuration" | "_holdSafetyTimer" | "plantedSlots" | "_consecutiveSkips" | "players" | "currentPlayer"> & {
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
