import { GamePausedData, GameStateSnapshot, ScoreRound } from "../models/interfaces";
import { applyWaitingPhoto } from "./waitingPhoto";

type Phase = "waiting-photo" | "answering" | "reveal" | "scores" | null;

export interface GameStateSetters {
  setPhoto: (v: string | null) => void;
  setIsOwner: (v: boolean) => void;
  setRound: (v: number) => void;
  setPhase: (v: Phase) => void;
  setPhaseDuration: (v: number) => void;
  setPhaseKey: (fn: (k: number) => number) => void;
  setCorrectAnswer: (v: string) => void;
  setScores: (v: ScoreRound[] | null) => void;
  setMySelection: (v: string) => void;
  setGameHeld: (v: boolean) => void;
  setPressing: (v: boolean) => void;
  /** The server's pause (countdown in ms, pause N of M), or null when the game is not paused */
  setPause: (v: GamePausedData | null) => void;
}

export interface GameStateResult {
  /** The game ended while we were away: show the final scores (snapshot.scores) */
  gameOver: boolean;
  /** Still in the ready phase: send im-ready again (one sent while offline was dropped) */
  sendReady: boolean;
  /** Answering phase: send the current pick again (one sent while offline was dropped). Never in reveal: answers
   *  freeze when answering ends, since round-reveal makes the answer public */
  resendGuess: boolean;
}

/**
 * Renders the `game-state` snapshot a rejoining player receives. `current` is the round and photo URL the screen
 * showed before the reconnect: the guess is kept only if it is still the same round. `pickSent: false` means the
 * current pick was made while disconnected: past answering (answers frozen) it never counted, so it is cleared.
 */
export const applyGameState = (
  snap: GameStateSnapshot,
  serverUrl: string,
  current: { round: number; photo: string | null; pickSent?: boolean },
  s: GameStateSetters
): GameStateResult => {
  const result: GameStateResult = { gameOver: false, sendReady: false, resendGuess: false };
  s.setPressing(false);
  if (!snap.started) {
    s.setPause(null);
    s.setGameHeld(false);
    return { ...result, gameOver: true };
  }
  s.setPause(snap.pause);
  s.setGameHeld(snap.held);

  const inRound = snap.phase === "answering" || snap.phase === "reveal" || snap.phase === "scores";
  if (inRound && snap.photo) {
    const photo = `${serverUrl}${snap.photo}`;
    const sameRound = snap.round === current.round && photo === current.photo;
    if (!sameRound || (snap.phase !== "answering" && current.pickSent === false)) s.setMySelection("");
    s.setPhoto(photo);
    s.setIsOwner(snap.isOwner === true);
    s.setRound(snap.round);
    s.setPhase(snap.phase as Phase);
    s.setPhaseDuration(snap.duration);
    s.setPhaseKey((k) => k + 1);
    s.setCorrectAnswer(snap.correctAnswer ?? "");
    s.setScores(snap.phase === "scores" ? snap.scores : null);
    return { ...result, resendGuess: snap.phase === "answering" };
  }

  // Waiting for the next photo: same screen as `waiting-photo` (snapshot round is the last played one)
  if (snap.phase === "waiting-photo") {
    applyWaitingPhoto({ round: snap.round + 1, duration: snap.duration }, s);
    return result;
  }

  // Ready phase: back to the "are you ready" screen until the first round
  s.setPhoto(null);
  s.setIsOwner(false);
  s.setPhase(null);
  s.setCorrectAnswer("");
  s.setScores(null);
  s.setMySelection("");
  return { ...result, sendReady: snap.phase === null };
};

/** Photo upload for `your-turn` request `attempt`, which the server re-sends after a reconnect or a pause. */
export interface TurnUpload {
  attempt: number;
  url?: string;
}

/**
 * What to do on `your-turn` for request `attempt`: "upload" a new photo, "resend" the already uploaded `url`
 * (a photo-sent emitted while offline or paused was dropped), or "wait" for the upload in flight.
 * A new request (new attempt, even with the same round number after a skip) always uploads again.
 */
export const turnUploadAction = (prev: TurnUpload | null, attempt: number): "upload" | "resend" | "wait" => {
  if (!prev || prev.attempt !== attempt) return "upload";
  return prev.url ? "resend" : "wait";
};

/** "4:59" style countdown text, rounded up so it never shows 0:00 before the end. */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export default applyGameState;
