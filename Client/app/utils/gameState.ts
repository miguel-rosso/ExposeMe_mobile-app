import { GameStateSnapshot, ScoreRound } from "../models/interfaces";

type Phase = "answering" | "reveal" | "scores" | null;

export interface GameStateSetters {
  setPhoto: (v: string | null) => void;
  setPhotoOwner: (v: string) => void;
  setRound: (v: number) => void;
  setPhase: (v: Phase) => void;
  setPhaseDuration: (v: number) => void;
  setPhaseKey: (fn: (k: number) => number) => void;
  setCorrectAnswer: (v: string) => void;
  setScores: (v: ScoreRound[] | null) => void;
  setMySelection: (v: string) => void;
  setGameHeld: (v: boolean) => void;
  setPressing: (v: boolean) => void;
  /** Pause countdown in ms (from the server), or null when the game is not paused */
  setPauseDuration: (v: number | null) => void;
}

export interface GameStateResult {
  /** The game ended while we were away: show the final scores (snapshot.scores) */
  gameOver: boolean;
  /** Still in the ready phase: send im-ready again (one sent while offline was dropped) */
  sendReady: boolean;
  /** Reveal phase: submit the current guess (the round-reveal that triggers it was missed) */
  submitGuess: boolean;
}

/**
 * Renders the `game-state` snapshot a rejoining player receives. `currentRound`/`currentOwner` are what the
 * screen showed before the reconnect: the guess is kept only if it is still the same round.
 */
export const applyGameState = (
  snap: GameStateSnapshot,
  serverUrl: string,
  current: { round: number; owner: string },
  s: GameStateSetters
): GameStateResult => {
  const result: GameStateResult = { gameOver: false, sendReady: false, submitGuess: false };
  s.setPressing(false);
  if (!snap.started) {
    s.setPauseDuration(null);
    s.setGameHeld(false);
    return { ...result, gameOver: true };
  }
  s.setPauseDuration(snap.pause ? snap.pause.duration : null);
  s.setGameHeld(snap.held);

  const inRound = snap.phase === "answering" || snap.phase === "reveal" || snap.phase === "scores";
  if (inRound && snap.photo && snap.owner) {
    const sameRound = snap.round === current.round && snap.owner === current.owner;
    if (!sameRound) s.setMySelection("");
    s.setPhoto(`${serverUrl}${snap.photo}`);
    s.setPhotoOwner(snap.owner);
    s.setRound(snap.round);
    s.setPhase(snap.phase as Phase);
    s.setPhaseDuration(snap.duration);
    s.setPhaseKey((k) => k + 1);
    s.setCorrectAnswer(snap.correctAnswer ?? "");
    s.setScores(snap.phase === "scores" ? snap.scores : null);
    return { ...result, submitGuess: snap.phase === "reveal" };
  }

  // Ready phase or waiting for the next photo: back to the "are you ready" screen until round-start
  s.setPhoto(null);
  s.setPhotoOwner("");
  s.setPhase(null);
  s.setCorrectAnswer("");
  s.setScores(null);
  s.setMySelection("");
  return { ...result, sendReady: snap.phase === null };
};

/** Photo upload for `your-turn`, which the server re-sends after a reconnect or a pause. */
export interface TurnUpload {
  round: number;
  url?: string;
}

/**
 * What to do on `your-turn` for `round`: "upload" a new photo, "resend" the already uploaded `url`
 * (a photo-sent emitted while offline or paused was dropped), or "wait" for the upload in flight.
 */
export const turnUploadAction = (prev: TurnUpload | null, round: number): "upload" | "resend" | "wait" => {
  if (!prev || prev.round !== round) return "upload";
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
