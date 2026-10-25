import { Socket } from "socket.io-client";
import type { GalleryAccess } from "@/app/utils/galleryAccess";

/** Player as the server sends it (public fields only: no socket id, rejoin token or planted photo URL). */
export interface Player {
  username: string;
  points: number;
  isHost: boolean;
  isReady: boolean;
  connected?: boolean; // Server-side connection state (false while disconnected)
  hasPlantedPhoto?: boolean;
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

/** `game-resumed`: the paused phase continues with `duration` ms */
export interface GameResumedData {
  phase: ServerPhase | null;
  duration: number;
}

/** `waiting-photo`: the whole room waits up to `duration` ms for round `round`'s photo (owner not revealed) */
export interface WaitingPhotoData {
  round: number;
  duration: number;
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
export interface GameStateSnapshot {
  started: boolean;
  phase: ServerPhase | null;
  round: number;
  totalRounds: number;
  owner: string | null;
  photo: string | null;
  correctAnswer: string | null;
  duration: number;
  held: boolean;
  pause: GamePausedData | null;
  scores: ScoreRound[];
  players: Player[];
}

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
  setRoundsOfGame: (rounds: number) => void;
  plantedPhotoUri: string | null;
  setPlantedPhotoUri: (uri: string | null) => void;
  uploadPlantedPhoto: () => Promise<string | null>;
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
  /** Limited access: system picker to share more photos (iOS 14+, Android 14+) */
  selectMorePhotos: () => Promise<void>;
  /** Subscribes to gallery / limited selection changes; returns the unsubscribe function */
  onGalleryChange: (listener: () => void) => () => void;
  setPhotoUri: React.Dispatch<React.SetStateAction<string | null>>;
  handleContinue: () => Promise<void>;
}

export interface PhotoProviderProps {
  children: React.ReactNode;
}
