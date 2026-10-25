import { ScoreRound } from "../models/interfaces";

/**
 * `round-start`: the round's photo and answer timer. The owner's name is never sent before `round-reveal`; only the
 * owner's own copy has `isOwner: true` (hold button, no voting).
 */
export interface RoundStartData {
  photo: string;
  round: number;
  duration: number;
  isOwner: boolean;
}

type Phase = "waiting-photo" | "answering" | "reveal" | "scores" | null;

export interface RoundStartSetters {
  setPhoto: (v: string | null) => void;
  /** This round's photo is mine (uploaded or planted by me) */
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
}

// Per-round reset applied on "round-start": new photo + answer phase, clears
// previous round answer/scores/selection and any leftover hold state.
export const applyRoundStart = (data: RoundStartData, serverUrl: string, s: RoundStartSetters) => {
  s.setPhoto(`${serverUrl}${data.photo}`);
  s.setIsOwner(data.isOwner === true);
  s.setRound(data.round);
  s.setPhase("answering");
  s.setPhaseDuration(data.duration);
  s.setPhaseKey((k) => k + 1);
  s.setCorrectAnswer("");
  s.setScores(null);
  s.setMySelection("");
  s.setGameHeld(false);
  s.setPressing(false);
};

export default applyRoundStart;
