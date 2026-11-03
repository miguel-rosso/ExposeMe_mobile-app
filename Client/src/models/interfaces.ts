import { Socket } from "socket.io-client";
import type { GalleryAccess } from "@/src/utils/galleryAccess";

/** Player as the server sends it (public fields only: no socket id, rejoin token or planted photo URL). */
export interface Player {
  username: string;
  points: number;
  isHost: boolean;
  connected?: boolean; // Server-side connection state (false while disconnected)
  lastAnswerCorrect?: boolean;
  lastGuess?: string;
}

export interface PhotoComponentProps {
  photoUrl: string;
  /** Request headers for photoUrl: server photos need photoAuthHeaders (room members only) */
  headers?: Record<string, string>;
  onLongPress?: () => void;
  onPressOut?: () => void;
}

export interface ScoreRound {
  username: string;
  points: number;
  isHost: boolean;
  lastAnswerCorrect: boolean;
  lastGuess: string;
}

export interface Room {
  gameCode: string;
  players: Player[];
  rounds: number;
  started?: boolean;
  /** Rounds played so far (0 until round 1's photo is shown). */
  round?: number;
  /** Phase in play, null in the lobby and the ready phase. */
  phase?: ServerPhase | null;
  /** The room's current game, or the last one when not started (0 before the first game). */
  gameNumber?: number;
}

export interface RandomPhotoResponse {
  gameCode: string;
  username: string;
  photo: string | null; //por ahora para probar
  round: number;
}

export interface JoinCreateGameData {
  gameCode: string | null;
  username: string;
  rejoinToken?: string; // Required by the server to rejoin with an existing username
}

export interface RoomOfGameResponse {
  success: boolean;
  room?: Room;
  message?: string;
  rejoinToken?: string; // Only sent to the joining player; keep it to rejoin after a reconnect
  hasPlantedPhoto?: boolean; // My own planted-photo mark on the server (never sent about other players)
}

export type ServerPhase = "waiting-photo" | "answering" | "reveal" | "scores";

/**
 * `game-paused`: fewer than 2 players connected; the game ends when `duration` (ms) runs out.
 * `pause` is this pause's would-be number (1..maxPauses); it repeats after a pause resumed within 10 s
 * (not counted). The game ends when another counted pause would be needed, or after 10 pauses in all.
 */
export interface GamePausedData {
  duration: number;
  waitingFor: string[];
  pause: number;
  maxPauses: number;
}

/**
 * Timing of a resync payload (`game-state`, `game-resumed`, `hold-resume`): `duration` ms left of the phase, whose
 * full duration (the `duration` its start event sent; `duration` itself when the countdown is shown whole) is
 * `phaseTotal`
 */
export interface ResyncTiming {
  duration: number;
  phaseTotal: number;
}

/** `game-resumed`: the paused phase continues with `duration` ms */
export interface GameResumedData extends ResyncTiming {
  phase: ServerPhase | null;
}

/**
 * `waiting-photo`: the whole room waits up to `duration` ms for the photo of round `round` of the room's game
 * `gameNumber` (owner not revealed)
 */
export interface WaitingPhotoData {
  round: number;
  duration: number;
  gameNumber: number;
}

/**
 * `round-start`: the round's photo and answer timer, the same for everyone (EXP-252). The app never shows the owner
 * anything before `round-reveal` and other players can't infer it; this client knows internally only because it
 * handled the `your-turn` and uploaded the photo.
 */
export interface RoundStartData {
  photo: string;
  round: number;
  duration: number;
}

/**
 * `round-reveal` (one per player): whose photo it was, shown for `duration` ms, and my own answer as the server froze
 * it (`""` = no guess): the pick the reveal colours, even if a later change of mine arrived too late to count
 */
export interface RoundRevealData {
  correctAnswer: string;
  duration: number;
  yourGuess: string;
}

/** `round-scores`: the scores after round `round`, shown for `duration` ms */
export interface RoundScoresData {
  scores: ScoreRound[];
  round: number;
  totalRounds: number;
  duration: number;
}

/** `hold-resume`: the held phase continues with `duration` ms */
export interface HoldResumeData extends ResyncTiming {
  phase: ServerPhase | null;
}

/** `hold-end`: the hold is over; `holdsLeft` holds the photo owner can still start this round (0: used up) */
export interface HoldEndData {
  holdsLeft: number;
}

/**
 * `your-turn` (only to me): send the photo for `round`. `attempt` identifies this photo request (new per owner pick,
 * also when the round number repeats after a skip); `photo-unavailable` echoes both.
 */
export interface YourTurnData {
  round: number;
  attempt: number;
}

/** Why a photo wait was skipped: the wait ran out, or the owner sent photo-unavailable */
export type RoundSkipReason = "timeout" | "unavailable";

/**
 * `round-skipped`: no photo for `round` (it is awaited again from another player). Only the awaited owner's own copy
 * has a `reason`: the room never learns why (EXP-110).
 */
export interface RoundSkippedData {
  round: number;
  reason?: RoundSkipReason;
}

/** `game-state`: snapshot sent to a player who rejoins (see Server/GAME_FLOW.md) */
export interface GameStateSnapshot extends ResyncTiming {
  started: boolean;
  /** The room's game in play, or the last one when not started (1, 2, ... per game started in the room; 0 for none) */
  gameNumber: number;
  phase: ServerPhase | null;
  round: number;
  totalRounds: number;
  photo: string | null;
  /** Whose photo it was, only from the reveal on (nobody, the owner included, is told earlier) */
  correctAnswer: string | null;
  /** My own answer as the server recorded it (`""` = no guess), only from the reveal on, like my `round-reveal` */
  yourGuess: string | null;
  held: boolean;
  /** Holds the photo owner can still start in the round in play (as in `hold-end`) */
  holdsLeft: number;
  pause: GamePausedData | null;
  scores: ScoreRound[];
  players: Player[];
  /**
   * The round's answer options in answering/reveal/scores (else empty): the players in the room at its round-start,
   * those who left since included (DEC-038)
   */
  roundOptions: Player[];
}

export type PlantUploadState = "idle" | "uploading" | "failed";

export interface GameContextProps {
  socket: Socket | null;
  /** Room this app is in or joining; null when it has none (Create game, or after leaving: Exit, kicked, refused) */
  gameCode: string | null;
  /** Room code in home's join panel: typed there, or a refused room's (an invite link's too), so the panel shows it
   *  again; Search room makes it the gameCode */
  joinCodeDraft: string;
  setJoinCodeDraft: (code: string) => void;
  username: string | null;
  /** The name saved on this device has been read at app start: `username` is now that name, or null if none */
  usernameLoaded: boolean;
  /** Home's Create game: forget the room code and let the next waiting room ask the server for a new room */
  requestNewRoom: () => void;
  /** Whether a new room was asked for since the last call (the waiting room takes it once, on opening) */
  takeNewRoomRequest: () => boolean;
  /** The server's reason for sending the player home (raw server text), for home to show once on its next focus */
  setHomeNotice: (notice: string) => void;
  /** The home notice set since the last call, or null (home takes it once, when focused) */
  takeHomeNotice: () => string | null;
  /** A room screen is going home on its own (Exit, kicked, refused): home closes the room's socket on its next focus */
  markRoomExit: () => void;
  /** Whether a room exit was marked since the last call (home takes it once, when focused) */
  takeRoomExit: () => boolean;
  /** The room an invite dialog asks about over the room's own screen (the game), or null when none asks there */
  setInviteOverRoomScreen: (code: string | null) => void;
  /** That room since the last call, or null (the room's screen takes it when it navigates on its own) */
  takeInviteOverRoomScreen: () => string | null;
  playersProvider: Player[];
  roundsOfGame: number;
  setGameCode: (code: string | null) => void;
  setUsername: (name: string | null) => void;
  /** Use `name` and save it on this device for the next launch */
  saveUsername: (name: string) => void;
  setPlayersProvider: React.Dispatch<React.SetStateAction<Player[]>>;
  startSocket: () => void;
  /** Close the socket and forget the room (gameCode) and the planted photo; the rejoin token is kept */
  endSocket: () => void;
  /** Leave the room for good: like endSocket, but sends leave-room first (socket closed once the server acks it)
   *  and forgets the rejoin token too */
  leaveRoom: () => void;
  setRoundsOfGame: (rounds: number) => void;
  /** Photo picked to plant in this game (cleared when the game socket ends) */
  plantedPhotoUri: string | null;
  setPlantedPhotoUri: (uri: string | null) => void;
  /** The server has the picked planted photo (uploaded + plant-photo) */
  plantedPhotoSent: boolean;
  /** Upload of the picked planted photo: running (with its retries), or given up (cleared by picking another) */
  plantUpload: PlantUploadState;
  /** Upload the picked photo and send plant-photo; true once the server has it */
  plantPhoto: () => Promise<boolean>;
  saveRejoinToken: (gameCode: string, username: string, token: string) => void;
  getRejoinToken: (gameCode: string, username: string) => Promise<string | null>;
  clearRejoinToken: () => void;
}

export interface GameProviderProps {
  children: React.ReactNode;
}

/** Why the player can't send a photo for their turn ("upload": picked but every upload attempt failed) */
export type PhotoUnavailableReason = "permission" | "no-photos" | "failed" | "upload";

/** In-game photo pick: a local URI, or why there is none */
export type GamePhotoResult = { uri: string } | { error: Exclude<PhotoUnavailableReason, "upload"> };

export interface PhotoContextProps {
  photoUri: string | null;
  requestGalleryPermission: (options: { askAgain: boolean }) => Promise<boolean>;
  getRandomPhoto: () => Promise<string | null>;
  /** Photo for your-turn: never navigates away from the game, uses limited access if that is all there is */
  pickGamePhoto: () => Promise<GamePhotoResult>;
  /** Gate to play: permission (full or limited) and at least one visible photo; `ask` shows the system prompt if it can */
  checkGalleryAccess: (options: { ask: boolean }) => Promise<GalleryAccess>;
  /** Only part of the gallery is shared (iOS limited, Android 14+ selected photos); permission read only */
  isLimitedAccess: () => Promise<boolean>;
  /** Limited access: system picker to share more photos (iOS 14+, Android 14+) */
  selectMorePhotos: () => Promise<void>;
  /** Subscribes to gallery / limited selection changes; returns the unsubscribe function */
  onGalleryChange: (listener: () => void) => () => void;
  setPhotoUri: React.Dispatch<React.SetStateAction<string | null>>;
  handleContinue: () => Promise<void>;
  /** New game: forget the photos already sent, which are otherwise not picked again within the game */
  resetUsedPhotos: () => void;
}

/** player-connection (server → lobby): a player is gone (disconnected past the grace) or came back */
export interface PlayerConnectionData {
  username: string;
  connected: boolean;
}

export interface PhotoProviderProps {
  children: React.ReactNode;
}
