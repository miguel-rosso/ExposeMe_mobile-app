export interface Player {
  username: string;
  points: number;
  socketId: string;
  isHost: boolean;
  isReady: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
  hasPlantedPhoto?: boolean;
  plantedPhoto?: string;
}

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
}

export interface RoomOfGameResponse {
  success: boolean;
  room?: Omit<Room, "_timer" | "_timerCallback" | "_timerStartedAt" | "_timerDuration" | "_holdSafetyTimer" | "plantedSlots">;
  message?: string;
  rounds?: number;
}
