import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldResumeData, RoundRevealData, RoundScoresData, RoundStartData, ScoreRound,
  ServerPhase, WaitingPhotoData,
} from "../models/interfaces";

// ── Round view: what the game screen shows of the server's current phase (see Server/GAME_FLOW.md) ──

export interface RoundView {
  photo: string | null;
  /** This round's photo is mine (only the owner is told, EXP-128) */
  isOwner: boolean;
  round: number;
  phase: ServerPhase | null;
  /** The server's duration for the current phase, in ms */
  phaseDuration: number;
  /** Changes with every phase/resume: restarts the progress bar */
  phaseKey: number;
  correctAnswer: string;
  scores: ScoreRound[] | null;
  mySelection: string;
  /** My last pick emitted while connected this round: the only one the server can have recorded */
  sentGuess: string;
  /** The server says the game is held */
  gameHeld: boolean;
  /** My finger is on the hold button */
  pressing: boolean;
}

export const initialRoundView: RoundView = {
  photo: null, isOwner: false, round: 0, phase: null, phaseDuration: 0, phaseKey: 0, correctAnswer: "", scores: null,
  mySelection: "", sentGuess: "", gameHeld: false, pressing: false,
};

export type RoundAction =
  | { type: "waiting-photo"; data: WaitingPhotoData }
  | { type: "your-turn"; round: number }
  | { type: "round-start"; data: RoundStartData; serverUrl: string }
  | { type: "round-reveal"; data: RoundRevealData }
  /** `username`: me, to show the guess the server recorded for me */
  | { type: "round-scores"; data: RoundScoresData; username: string }
  | { type: "pick"; guess: string }
  | { type: "pick-sent"; guess: string }
  | { type: "pressing"; pressing: boolean }
  | { type: "hold-start" }
  | { type: "hold-end" }
  | { type: "hold-resume"; data: HoldResumeData }
  | { type: "game-paused" }
  | { type: "game-resumed"; data: GameResumedData }
  /** `username`: me, to show the guess the server recorded for me in a `scores` snapshot */
  | { type: "game-state"; snap: GameStateSnapshot; serverUrl: string; username: string };

/** A new server phase (or the same one resumed) with its duration: restarts the progress bar */
const startPhase = (state: RoundView, phase: ServerPhase | null, duration: number): RoundView => ({
  ...state, phase, phaseDuration: duration, phaseKey: state.phaseKey + 1,
});

/** Leaves the previous round: no answer, scores, pick or hold left over */
const PER_ROUND_RESET = {
  correctAnswer: "", scores: null, mySelection: "", sentGuess: "", gameHeld: false, pressing: false,
} as const;

/** The guess the server recorded for me (`lastGuess`, "" for none), or `fallback` if I'm not in the scores */
const recordedGuess = (scores: ScoreRound[], username: string, fallback: string) =>
  scores.find((s) => s.username === username)?.lastGuess ?? fallback;

const inRoundPhase = (phase: ServerPhase | null) => phase === "answering" || phase === "reveal" || phase === "scores";

/** The snapshot shows a round in play (answering/reveal/scores) with its photo */
const showsRound = (snap: GameStateSnapshot) => inRoundPhase(snap.phase) && !!snap.photo;

/**
 * `waiting-photo` (and a `game-state` in that phase): leave the previous round's photo and scores and show the
 * waiting screen for round `round`, with the server's `duration` for the progress bar.
 */
const waitForPhoto = (state: RoundView, data: WaitingPhotoData): RoundView => ({
  ...startPhase(state, "waiting-photo", data.duration), ...PER_ROUND_RESET, photo: null, isOwner: false, round: data.round,
});

/**
 * The pick to show in a snapshot of a round in play, as the live events would: while answering the current pick of the
 * same round (the screen re-sends it); in reveal the last one sent (a pick made while disconnected never counted); in
 * scores the guess the server recorded for me.
 */
const snapshotSelection = (state: RoundView, snap: GameStateSnapshot, sameRound: boolean, username: string) => {
  const sentGuess = sameRound ? state.sentGuess : "";
  if (snap.phase === "answering") return sameRound ? state.mySelection : "";
  if (snap.phase === "scores") return recordedGuess(snap.scores, username, sentGuess);
  return sentGuess;
};

/** Renders the `game-state` snapshot a rejoining player receives (the pick shown: see snapshotSelection) */
const applySnapshot = (state: RoundView, snap: GameStateSnapshot, serverUrl: string, username: string): RoundView => {
  if (!snap.started) return { ...state, pressing: false, gameHeld: false };
  const held = { ...state, pressing: false, gameHeld: snap.held };

  if (showsRound(snap)) {
    const photo = `${serverUrl}${snap.photo}`;
    const sameRound = snap.round === state.round && photo === state.photo;
    return {
      ...startPhase(held, snap.phase, snap.duration),
      photo, isOwner: snap.isOwner === true, round: snap.round, correctAnswer: snap.correctAnswer ?? "",
      scores: snap.phase === "scores" ? snap.scores : null,
      mySelection: snapshotSelection(state, snap, sameRound, username),
      sentGuess: sameRound ? state.sentGuess : "",
    };
  }

  // Waiting for the next photo: same screen as `waiting-photo` (snapshot round is the last played one)
  if (snap.phase === "waiting-photo") return waitForPhoto(held, { round: snap.round + 1, duration: snap.duration });

  // Ready phase: back to the "are you ready" screen until the first round
  return {
    ...held, photo: null, isOwner: false, phase: null, correctAnswer: "", scores: null, mySelection: "", sentGuess: "",
  };
};

export const roundReducer = (state: RoundView, action: RoundAction): RoundView => {
  switch (action.type) {
    case "waiting-photo":
      return waitForPhoto(state, action.data);
    case "your-turn":
      return { ...state, round: action.round };
    // New round: its photo and answer phase, nothing left of the previous round
    case "round-start":
      return {
        ...startPhase(state, "answering", action.data.duration), ...PER_ROUND_RESET,
        photo: `${action.serverUrl}${action.data.photo}`, isOwner: action.data.isOwner === true, round: action.data.round,
      };
    // Answers are frozen: a pick not sent by now never counted, so the reveal colours the last one sent
    case "round-reveal":
      return {
        ...startPhase(state, "reveal", action.data.duration), correctAnswer: action.data.correctAnswer,
        mySelection: state.sentGuess,
      };
    // The scores carry the guess the server actually recorded for me (a sent pick can still arrive too late)
    case "round-scores":
      return {
        ...startPhase(state, "scores", action.data.duration), scores: action.data.scores, round: action.data.round,
        mySelection: recordedGuess(action.data.scores, action.username, state.mySelection),
      };
    case "pick":
      return { ...state, mySelection: action.guess };
    case "pick-sent":
      return { ...state, sentGuess: action.guess };
    case "pressing":
      return { ...state, pressing: action.pressing };
    case "hold-start":
      return { ...state, gameHeld: true };
    case "hold-end":
    case "game-paused":
      return { ...state, gameHeld: false, pressing: false };
    // The held phase continues with the remaining time
    case "hold-resume":
      return { ...startPhase(state, state.phase, action.data.duration), gameHeld: false, pressing: false };
    case "game-resumed": {
      // Paused between rounds (after scores): the next round's photo is awaited now
      const nextRoundPhoto = action.data.phase === "waiting-photo" && state.phase !== "waiting-photo";
      const resumed = nextRoundPhoto
        ? { ...state, photo: null, isOwner: false, scores: null, phase: "waiting-photo" as const, round: state.round + 1 }
        : state;
      return startPhase(resumed, resumed.phase, action.data.duration);
    }
    case "game-state":
      return applySnapshot(state, action.snap, action.serverUrl, action.username);
  }
};

// ── What the screen sends after a `game-state` snapshot ──

export interface GameStateResult {
  /** The game ended while we were away: show the final scores (snapshot.scores) */
  gameOver: boolean;
  /** Still in the ready phase: send im-ready again (one sent while offline was dropped) */
  sendReady: boolean;
  /** Answering phase: send the current pick again (one sent while offline was dropped). Never in reveal: answers
   *  freeze when answering ends, since round-reveal makes the answer public */
  resendGuess: boolean;
  /** The server's pause to show (countdown in ms, pause N of M); null clears any pause shown before the snapshot */
  pause: GamePausedData | null;
}

export const gameStateFollowUps = (snap: GameStateSnapshot): GameStateResult => ({
  pause: snap.started ? snap.pause : null,
  gameOver: !snap.started,
  sendReady: snap.started && snap.phase === null,
  resendGuess: snap.started && showsRound(snap) && snap.phase === "answering",
});
