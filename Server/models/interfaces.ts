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

/**
 * `waiting-photo` (room-wide): round `round` of game `gameNumber` (Room.gameNumber) awaits its photo for up to
 * `duration` ms; never names the owner
 */
export interface WaitingPhotoData {
  round: number;
  duration: number;
  gameNumber: number;
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

/** Why a photo wait was skipped: the wait ran out, or the owner sent photo-unavailable */
export type RoundSkipReason = "timeout" | "unavailable";

/**
 * `round-skipped`: no photo for `round`. Only the copy sent to the awaited owner says why: the room can't tell an owner
 * without photos from a slow one (EXP-110).
 */
export interface RoundSkippedData {
  round: number;
  reason?: RoundSkipReason;
}

export interface Room {
  gameCode: string;
  players: Player[];
  rounds: number;
  started: boolean;
  /**
   * The room's current or last game: 0 before its first one, +1 on every game started. Sent in game-started,
   * waiting-photo and game-state, so a client tells a snapshot of the next game from one of the game it showed
   */
  gameNumber: number;
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
  /** Pauses started in this game, refunded or not (at most MAX_TOTAL_PAUSES, then game over) */
  _totalPauses: number;
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

/**
 * Why start-game was refused: the socket is in no room, the sender is not the host, a game is already running, or
 * fewer than 2 players are left once the gone (disconnected past the grace) ones were removed.
 */
export type StartRefusal = "not-in-room" | "not-host" | "already-started" | "not-enough-players";

/**
 * start-game's acknowledgement. A not-enough-players refusal names the gone players that start removed (also told
 * to the room with player-left), so the host can be told why the game didn't start.
 */
export type StartGameAck =
  | { ok: true }
  | { ok: false; reason: "not-enough-players"; removed: string[] }
  | { ok: false; reason: Exclude<StartRefusal, "not-enough-players"> };

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

/** `room-of-game`: the answer to join-create-game, only to the joining socket (the room carries the round count) */
export interface RoomOfGameResponse {
  success: boolean;
  room?: SafeRoom;
  /** Why the join was refused (success false) */
  message?: string;
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
 * `round-start`: the round's photo and answer timer, the same for the whole room. The unmodified app never shows the
 * photo owner (uploader or planter) anything before `round-reveal` and other players can't infer it; the owner's own
 * client necessarily knows (it received `your-turn` and uploaded the photo).
 */
export interface RoundStartData {
  photo: string;
  round: number;
  duration: number;
}

/**
 * `round-reveal`, one per player: whose photo it was (the same for everyone), shown for `duration` ms, and the
 * recipient's own answer as the server recorded it when answers froze (`""` = no guess), so the reveal colours the
 * pick that counted, not one still in flight.
 */
export interface RoundRevealData {
  correctAnswer: string;
  duration: number;
  yourGuess: string;
}

/**
 * `game-resumed` / `hold-resume`: the paused or held `phase` continues with `duration` ms left of its `phaseTotal`
 * (the full countdown its start event sent).
 */
export interface PhaseResumeData {
  phase: RoundPhase | null;
  duration: number;
  phaseTotal: number;
}

/**
 * `hold-end`: the hold is over (released, force-released or ended by a pause); `holdsLeft` holds the photo owner can
 * still start this round's scores, 0 once the count or the time budget is used up or too little of the scoreboard is
 * left for one (see GameEngine.holdsLeft).
 */
export interface HoldEndData {
  holdsLeft: number;
}

/**
 * The room-wide part of `game-state`, the same for every recipient.
 * `duration` is the remaining time of the current phase (frozen while paused or held), `phaseTotal` its full
 * countdown as its start event sent it, so the client's bar resumes at the right point.
 */
export interface RoomStateSnapshot {
  started: boolean;
  /** The room's current game, or the last one when not started (Room.gameNumber) */
  gameNumber: number;
  phase: RoundPhase | null;
  round: number;
  totalRounds: number;
  /** Photo path, only in answering/reveal/scores */
  photo: string | null;
  /** Only in reveal/scores */
  correctAnswer: string | null;
  duration: number;
  phaseTotal: number;
  held: boolean;
  /** Holds the photo owner can still start in the round in play (as in `hold-end`; in waiting-photo, the last round) */
  holdsLeft: number;
  /** The pause in progress (same as the last `game-paused`), or null when not paused */
  pause: PauseInfo | null;
  scores: ScoreRound[];
  players: PublicPlayer[];
  /**
   * In answering/reveal/scores: the round's answer options, the players in the room at its round-start (room order),
   * those who left since included (DEC-038); else empty
   */
  roundOptions: PublicPlayer[];
}

/**
 * `game-state`: sent only to a player who rejoins, so a reconnecting client can render the current phase. The room-wide
 * snapshot plus the recipient's own recorded answer, only from the reveal on (as in their `round-reveal`).
 */
export interface GameStateSnapshot extends RoomStateSnapshot {
  /** Only in reveal/scores: the recipient's answer as recorded when answers froze (`""` = no guess) */
  yourGuess: string | null;
}
