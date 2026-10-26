import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldResumeData, RoundRevealData, RoundScoresData, RoundStartData, ScoreRound,
  ServerPhase, WaitingPhotoData,
} from "../models/interfaces";

// ── Round view: what the game screen shows of the server's current phase (see Server/GAME_FLOW.md) ──

export interface RoundView {
  photo: string | null;
  round: number;
  phase: ServerPhase | null;
  /** The server's duration for the current phase, in ms: what is left of it when it was resumed */
  phaseDuration: number;
  /** The current phase's full duration, in ms, as first received: a resume or snapshot only sends what is left */
  phaseTotal: number;
  /** Changes with every phase/resume: restarts the progress bar */
  phaseKey: number;
  /** Whose photo it was: "" until round-reveal (nobody, the owner included, is told earlier: EXP-252) */
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
  photo: null, round: 0, phase: null, phaseDuration: 0, phaseTotal: 0, phaseKey: 0, correctAnswer: "", scores: null,
  mySelection: "", sentGuess: "", gameHeld: false, pressing: false,
};

/**
 * The revealed answer (`correctAnswer`) is me: the round's photo was mine. The only way the owner's screen learns it,
 * from round-reveal on (hold button, "It was your photo!").
 */
export const isRevealedOwner = (correctAnswer: string, username: string | null | undefined): boolean =>
  !!username && correctAnswer === username;

export type RoundAction =
  | { type: "waiting-photo"; data: WaitingPhotoData }
  | { type: "your-turn"; round: number }
  | { type: "round-start"; data: RoundStartData; serverUrl: string }
  | { type: "round-reveal"; data: RoundRevealData }
  | { type: "round-scores"; data: RoundScoresData }
  | { type: "pick"; guess: string }
  | { type: "pick-sent"; guess: string }
  | { type: "pressing"; pressing: boolean }
  | { type: "hold-start" }
  | { type: "hold-end" }
  | { type: "hold-resume"; data: HoldResumeData }
  | { type: "game-paused" }
  | { type: "game-resumed"; data: GameResumedData }
  | { type: "game-state"; snap: GameStateSnapshot; serverUrl: string };

/**
 * A server phase with its duration: remounts the progress bar (phaseKey), empty unless continuedPhase keeps the
 * phase's full duration (the same phase resumed)
 */
const startPhase = (state: RoundView, phase: ServerPhase | null, duration: number): RoundView => ({
  ...state, phase, phaseDuration: duration, phaseTotal: duration, phaseKey: state.phaseKey + 1,
});

/**
 * `next` goes on with the phase `previous` showed (a resume, a hold released, a snapshot of the same phase): it keeps
 * the phase's full duration, so its progress bar continues from where it was (see phaseElapsed). A resume may get
 * more time than was left (the server's minimum), never more than a whole phase.
 */
const continuedPhase = (previous: RoundView, next: RoundView): RoundView => ({
  ...next, phaseTotal: Math.max(previous.phaseTotal, next.phaseDuration),
});

/** Fraction of the current phase already gone, where its progress bar starts: 0 for a phase seen from its start */
export const phaseElapsed = ({ phaseDuration, phaseTotal }: Pick<RoundView, "phaseDuration" | "phaseTotal">): number =>
  phaseTotal > 0 ? 1 - phaseDuration / phaseTotal : 0;

/** Leaves the previous round: no answer, scores, pick or hold left over */
const PER_ROUND_RESET = {
  correctAnswer: "", scores: null, mySelection: "", sentGuess: "", gameHeld: false, pressing: false,
} as const;

const inRoundPhase = (phase: ServerPhase | null) => phase === "answering" || phase === "reveal" || phase === "scores";

/** The snapshot shows a round in play (answering/reveal/scores) with its photo */
const showsRound = (snap: GameStateSnapshot) => inRoundPhase(snap.phase) && !!snap.photo;

/**
 * `waiting-photo` (and a `game-state` in that phase): leave the previous round's photo and scores and show the
 * waiting screen for round `round`, with the server's `duration` for the progress bar.
 */
const waitForPhoto = (state: RoundView, data: WaitingPhotoData): RoundView => ({
  ...startPhase(state, "waiting-photo", data.duration), ...PER_ROUND_RESET, photo: null, round: data.round,
});

/**
 * The pick to show in a snapshot of a round in play, as the live events would: while answering the current pick of the
 * same round (the screen re-sends it); past answering the last one sent (a pick made while disconnected never counted),
 * which the reveal colours. In scores the options are not drawn: the scoreboard lists the guess the server recorded.
 */
const snapshotSelection = (state: RoundView, snap: GameStateSnapshot, sameRound: boolean) => {
  if (snap.phase === "answering") return sameRound ? state.mySelection : "";
  return sameRound ? state.sentGuess : "";
};

/** Renders the `game-state` snapshot a rejoining player receives (the pick shown: see snapshotSelection) */
const applySnapshot = (state: RoundView, snap: GameStateSnapshot, serverUrl: string): RoundView => {
  if (!snap.started) return { ...state, pressing: false, gameHeld: false };
  const held = { ...state, pressing: false, gameHeld: snap.held };

  if (showsRound(snap)) {
    const photo = `${serverUrl}${snap.photo}`;
    const sameRound = snap.round === state.round && photo === state.photo;
    const next: RoundView = {
      ...startPhase(held, snap.phase, snap.duration),
      photo, round: snap.round, correctAnswer: snap.correctAnswer ?? "",
      scores: snap.phase === "scores" ? snap.scores : null,
      mySelection: snapshotSelection(state, snap, sameRound),
      sentGuess: sameRound ? state.sentGuess : "",
    };
    return sameRound && snap.phase === state.phase ? continuedPhase(state, next) : next;
  }

  // Waiting for the next photo: same screen as `waiting-photo` (snapshot round is the last played one)
  if (snap.phase === "waiting-photo") {
    const next = waitForPhoto(held, { round: snap.round + 1, duration: snap.duration });
    return state.phase === "waiting-photo" && state.round === next.round ? continuedPhase(state, next) : next;
  }

  // Ready phase: back to the "are you ready" screen until the first round
  return {
    ...held, photo: null, phase: null, correctAnswer: "", scores: null, mySelection: "", sentGuess: "",
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
        photo: `${action.serverUrl}${action.data.photo}`, round: action.data.round,
      };
    // Answers are frozen: a pick not sent by now never counted, so the reveal colours the last one sent
    case "round-reveal":
      return {
        ...startPhase(state, "reveal", action.data.duration), correctAnswer: action.data.correctAnswer,
        mySelection: state.sentGuess,
      };
    // The scoreboard lists the guess the server recorded for each player; the options are not drawn under it
    case "round-scores":
      return { ...startPhase(state, "scores", action.data.duration), scores: action.data.scores, round: action.data.round };
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
      return continuedPhase(state, {
        ...startPhase(state, state.phase, action.data.duration), gameHeld: false, pressing: false,
      });
    case "game-resumed": {
      // Paused between rounds (after scores): the next round's photo is awaited now, a new phase
      const nextRoundPhoto = action.data.phase === "waiting-photo" && state.phase !== "waiting-photo";
      if (nextRoundPhoto) {
        const nextRound = { ...state, photo: null, scores: null, round: state.round + 1 };
        return startPhase(nextRound, "waiting-photo", action.data.duration);
      }
      return continuedPhase(state, startPhase(state, state.phase, action.data.duration));
    }
    case "game-state":
      return applySnapshot(state, action.snap, action.serverUrl);
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
