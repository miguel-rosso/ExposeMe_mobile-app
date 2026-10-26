import { Socket } from "socket.io-client";
import type { GalleryAccess } from "@/app/utils/galleryAccess";

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

/** `waiting-photo`: the whole room waits up to `duration` ms for round `round`'s photo (owner not revealed) */
export interface WaitingPhotoData {
  round: number;
  duration: number;
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

/** `round-reveal`: whose photo it was, shown for `duration` ms */
export interface RoundRevealData {
  correctAnswer: string;
  duration: number;
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

/**
 * `your-turn` (only to me): send the photo for `round`. `attempt` identifies this photo request (new per owner pick,
 * also when the round number repeats after a skip); `photo-unavailable` echoes both.
 */
export interface YourTurnData {
  round: number;
  attempt: number;
}

/** `round-skipped`: no photo for `round` (it is awaited again from another player) */
export interface RoundSkippedData {
  round: number;
  reason: "timeout" | "unavailable";
}

/** `game-state`: snapshot sent to a player who rejoins (see Server/GAME_FLOW.md) */
export interface GameStateSnapshot extends ResyncTiming {
  started: boolean;
  phase: ServerPhase | null;
  round: number;
  totalRounds: number;
  photo: string | null;
  /** Whose photo it was, only from the reveal on (nobody, the owner included, is told earlier) */
  correctAnswer: string | null;
  held: boolean;
  pause: GamePausedData | null;
  scores: ScoreRound[];
  players: Player[];
}

export type PlantUploadState = "idle" | "uploading" | "failed";

export interface GameContextProps {
  socket: Socket | null;
  gameCode: string | null;
  username: string | null;
  playersProvider: Player[];
  roundsOfGame: number;
  setGameCode: (code: string | null) => void;
  setUsername: (name: string | null) => void;
  setPlayersProvider: (players: Player[]) => void;
  startSocket: () => void;
  endSocket: () => void;
  /** Leave the room for good: leave-room (socket closed once the server acks it), rejoin token forgotten */
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
