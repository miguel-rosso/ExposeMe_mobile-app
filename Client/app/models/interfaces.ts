import { Socket } from "socket.io-client";

export interface Player {
  username: string;
  points: number;
  socketId: string;
  isHost: boolean;
  isReady: boolean;
  connected?: boolean; // Server-side connection state (false while disconnected)
  hasPlantedPhoto?: boolean; // Changed from plantedPhoto to hasPlantedPhoto (boolean flag)
  plantedPhoto?: string; // This will be set on the server side when actually uploading
}

export interface PhotoComponentProps {
  photoUrl: string;
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

/** `game-paused`: fewer than 2 players connected; the game ends when `duration` (ms) runs out */
export interface GamePausedData {
  duration: number;
  waitingFor: string[];
}

/** `game-resumed`: the paused phase continues with `duration` ms */
export interface GameResumedData {
  phase: ServerPhase | null;
  duration: number;
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

export interface PhotoContextProps {
  photoUri: string | null;
  requestGalleryPermission: (options: { askAgain: boolean }) => Promise<boolean>;
  getRandomPhoto: () => Promise<string | null>;
  setPhotoUri: React.Dispatch<React.SetStateAction<string | null>>;
  handleContinue: () => Promise<void>;
}

export interface PhotoProviderProps {
  children: React.ReactNode;
}
