export interface Player {
  username: string;
  points: number;
  socketId: string;
  isHost: boolean;
  isReady: boolean;
  /** False while the player's socket is disconnected (kept in the room so they can rejoin) */
  connected: boolean;
  /** When the player last disconnected (ms epoch); unset while connected. See RoomManager.isGone. */
  disconnectedAt?: number;
  /** The lobby was told (player-connection) that this player is gone; cleared when they rejoin */
  goneAnnounced?: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
  hasPlantedPhoto?: boolean;
  plantedPhoto?: string;
  /** Secret returned only to this player's socket; required to rejoin with this username. Never broadcast. */
  rejoinToken: string;
}

/**
 * Player as sent to clients: an explicit allowlist (RoomManager.publicPlayer). Never the socket id, rejoin token,
 * planted photo URL, whether they planted one, or whether they sent im-ready; `points`/`lastGuess`/`lastAnswerCorrect` exclude the round in play until round-scores.
 */
export interface PublicPlayer {
  username: string;
  points: number;
  isHost: boolean;
  connected: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
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

/** `waiting-photo` (room-wide): round `round`'s photo is awaited for up to `duration` ms; never names the owner */
export interface WaitingPhotoData {
  round: number;
  duration: number;
}

/**
 * `your-turn` (owner only): send the photo for `round`. `attempt` identifies this photo request (a new one per owner
 * pick, also when the round number repeats after a skip); `photo-unavailable` must echo both.
 */
export interface YourTurnData {
  round: number;
  attempt: number;
}

/** `photo-unavailable` (client → server): the owner of request `attempt` for `round` has no photo to send */
export type PhotoUnavailableData = YourTurnData;

/** `round-skipped`: no photo for `round` — the wait ran out, or the owner sent photo-unavailable */
export interface RoundSkippedData {
  round: number;
  reason: "timeout" | "unavailable";
}

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
  /** Pauses started in this game (each gets PAUSE_TIMEOUT; at most MAX_PAUSES, then game over) */
  _pauseCount: number;
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

  /** Lobby: fires when the next disconnected player's DISCONNECT_GRACE runs out (GameEngine.reviewLobby) */
  _lobbyTimer: NodeJS.Timeout | null;
}

/** `player-connection` (lobby only): a player is gone (disconnected > DISCONNECT_GRACE) or came back */
export interface PlayerConnectionData {
  username: string;
  connected: boolean;
}

export interface JoinCreateGameData {
  gameCode: string | null;
  username: string;
  /** Token from a previous room-of-game; required to rejoin with an existing username */
  rejoinToken?: string;
}

/** Room as sent in room-of-game: an explicit allowlist (RoomManager.safeRoomData); never names the photo owner. */
export interface SafeRoom {
  gameCode: string;
  rounds: number;
  started: boolean;
  round: number;
  phase: RoundPhase | null;
  held: boolean;
  paused: boolean;
  players: PublicPlayer[];
}

export interface RoomOfGameResponse {
  success: boolean;
  room?: SafeRoom;
  message?: string;
  rounds?: number;
  /** Only in the response to the joining socket itself */
  rejoinToken?: string;
  /** The joining player's own planted-photo mark (never sent about anyone else) */
  hasPlantedPhoto?: boolean;
}

/** `game-paused` payload: countdown left (ms), who is awaited, and this pause's number (1..maxPauses) */
export interface PauseInfo {
  duration: number;
  waitingFor: string[];
  pause: number;
  maxPauses: number;
}

/**
 * `round-start`: the round's photo and answer timer. Sent per recipient: `isOwner` is true only to the photo owner
 * (uploader or planter), so nobody else learns whose photo it is before `round-reveal`.
 */
export interface RoundStartData {
  photo: string;
  round: number;
  duration: number;
  isOwner: boolean;
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
  /**
   * This recipient is the photo owner of the round in play (answering/reveal/scores). Per recipient: the owner's
   * name is never sent before the reveal (`correctAnswer`), only this flag to the owner themselves
   */
  isOwner: boolean;
  /** Photo path, only in answering/reveal/scores */
  photo: string | null;
  /** Only in reveal/scores */
  correctAnswer: string | null;
  duration: number;
  held: boolean;
  /** The pause in progress (same as the last `game-paused`), or null when not paused */
  pause: PauseInfo | null;
  scores: ScoreRound[];
  players: PublicPlayer[];
}
