import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldResumeData, ResyncTiming, RoundRevealData, RoundScoresData,
  RoundStartData, ScoreRound, ServerPhase, WaitingPhotoData,
} from "../models/interfaces";

// ── Round view: what the game screen shows of the server's current phase (see Server/GAME_FLOW.md) ──

export interface RoundView {
  photo: string | null;
  round: number;
  phase: ServerPhase | null;
  /** The server's duration for the current phase, in ms: what is left of it when it was resumed */
  phaseDuration: number;
  /**
   * The current phase's full duration, in ms: its start event's `duration`, or the `phaseTotal` of a resume or
   * snapshot (which sends what is left as `duration`)
   */
  phaseTotal: number;
  /** Changes with every phase/resume: restarts the progress bar */
  phaseKey: number;
  /** Whose photo it was: "" until round-reveal (nobody, the owner included, is told earlier: EXP-252) */
  correctAnswer: string;
  scores: ScoreRound[] | null;
  /** My pick: the local one while answering, the one the server recorded from the reveal on */
  mySelection: string;
  /** The server says the game is held */
  gameHeld: boolean;
  /** My finger is on the hold button */
  pressing: boolean;
}

export const initialRoundView: RoundView = {
  photo: null, round: 0, phase: null, phaseDuration: 0, phaseTotal: 0, phaseKey: 0, correctAnswer: "", scores: null,
  mySelection: "", gameHeld: false, pressing: false,
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
  | { type: "pressing"; pressing: boolean }
  | { type: "hold-start" }
  | { type: "hold-end" }
  | { type: "hold-resume"; data: HoldResumeData }
  | { type: "game-paused" }
  | { type: "game-resumed"; data: GameResumedData }
  | { type: "game-state"; snap: GameStateSnapshot; serverUrl: string };

/**
 * A server phase with `duration` ms left of its full duration `total` (a start event: the whole phase is left):
 * remounts the progress bar (phaseKey), which starts at the fraction already gone (see phaseElapsed)
 */
const startPhase = (state: RoundView, phase: ServerPhase | null, duration: number, total = duration): RoundView => ({
  ...state, phase, phaseDuration: duration, phaseTotal: total, phaseKey: state.phaseKey + 1,
});

/**
 * The server's phase from a resync payload (`game-state`, `game-resumed`, `hold-resume`): what is left of it and its
 * full duration, so the bar goes on from where the phase is, whether or not this screen saw it start
 */
const resyncPhase = (state: RoundView, phase: ServerPhase | null, timing: ResyncTiming): RoundView =>
  startPhase(state, phase, timing.duration, timing.phaseTotal);

/** Fraction of the current phase already gone, where its progress bar starts: 0 for a phase seen from its start */
export const phaseElapsed = ({ phaseDuration, phaseTotal }: Pick<RoundView, "phaseDuration" | "phaseTotal">): number =>
  phaseTotal > 0 ? Math.max(0, 1 - phaseDuration / phaseTotal) : 0;

/** Leaves the previous round: no answer, scores, pick or hold left over */
const PER_ROUND_RESET = {
  correctAnswer: "", scores: null, mySelection: "", gameHeld: false, pressing: false,
} as const;

const inRoundPhase = (phase: ServerPhase | null) => phase === "answering" || phase === "reveal" || phase === "scores";

/** The snapshot shows a round in play (answering/reveal/scores) with its photo */
const showsRound = (snap: GameStateSnapshot) => inRoundPhase(snap.phase) && !!snap.photo;

/**
 * `waiting-photo` (and a `game-state` in that phase): leave the previous round's photo and scores and show the
 * waiting screen for round `round`, with the server's `duration` (of the wait's full `total`) for the progress bar.
 */
const waitForPhoto = (state: RoundView, round: number, duration: number, total = duration): RoundView => ({
  ...startPhase(state, "waiting-photo", duration, total), ...PER_ROUND_RESET, photo: null, round,
});

/**
 * The pick to show in a snapshot of a round in play, as the live events would: while answering the current pick of the
 * same round (the screen re-sends it); past answering the one the server recorded for me (`yourGuess`), which the
 * reveal colours. In scores the options are not drawn: the scoreboard lists the guess the server recorded.
 */
const snapshotSelection = (state: RoundView, snap: GameStateSnapshot, sameRound: boolean) => {
  if (snap.phase === "answering") return sameRound ? state.mySelection : "";
  return snap.yourGuess ?? "";
};

/** Renders the `game-state` snapshot a rejoining player receives (the pick shown: see snapshotSelection) */
const applySnapshot = (state: RoundView, snap: GameStateSnapshot, serverUrl: string): RoundView => {
  if (!snap.started) return { ...state, pressing: false, gameHeld: false };
  const held = { ...state, pressing: false, gameHeld: snap.held };

  if (showsRound(snap)) {
    const photo = `${serverUrl}${snap.photo}`;
    const sameRound = snap.round === state.round && photo === state.photo;
    return {
      ...resyncPhase(held, snap.phase, snap),
      photo, round: snap.round, correctAnswer: snap.correctAnswer ?? "",
      scores: snap.phase === "scores" ? snap.scores : null,
      mySelection: snapshotSelection(state, snap, sameRound),
    };
  }

  // Waiting for the next photo: same screen as `waiting-photo` (snapshot round is the last played one)
  if (snap.phase === "waiting-photo") return waitForPhoto(held, snap.round + 1, snap.duration, snap.phaseTotal);

  // Ready phase: back to the "are you ready" screen until the first round
  return {
    ...held, photo: null, phase: null, correctAnswer: "", scores: null, mySelection: "",
  };
};

export const roundReducer = (state: RoundView, action: RoundAction): RoundView => {
  switch (action.type) {
    case "waiting-photo":
      return waitForPhoto(state, action.data.round, action.data.duration);
    case "your-turn":
      return { ...state, round: action.round };
    // New round: its photo and answer phase, nothing left of the previous round
    case "round-start":
      return {
        ...startPhase(state, "answering", action.data.duration), ...PER_ROUND_RESET,
        photo: `${action.serverUrl}${action.data.photo}`, round: action.data.round,
      };
    // Answers are frozen: the reveal colours the pick the server recorded for me, not a later one that never counted
    case "round-reveal":
      return {
        ...startPhase(state, "reveal", action.data.duration), correctAnswer: action.data.correctAnswer,
        mySelection: action.data.yourGuess,
      };
    // The scoreboard lists the guess the server recorded for each player; the options are not drawn under it
    case "round-scores":
      return { ...startPhase(state, "scores", action.data.duration), scores: action.data.scores, round: action.data.round };
    case "pick":
      return { ...state, mySelection: action.guess };
    case "pressing":
      return { ...state, pressing: action.pressing };
    case "hold-start":
      return { ...state, gameHeld: true };
    // The end of a hold leaves `pressing` (my finger) alone: it may be the answer to a release of mine that arrives
    // after I pressed again, and that new press must still send its release. A release after a hold the server ended
    // by itself is ignored by the server (I hold nothing).
    case "hold-end":
      return { ...state, gameHeld: false };
    case "game-paused":
      return { ...state, gameHeld: false, pressing: false };
    // The held phase continues with the remaining time
    case "hold-resume":
      return { ...resyncPhase(state, action.data.phase, action.data), gameHeld: false };
    // The server's phase goes on, also when this screen still showed an earlier one (the game-state that follows a
    // rejoin fills in what that phase shows)
    case "game-resumed": {
      // Paused between rounds (after scores): the next round's photo is awaited now
      const nextRoundPhoto = action.data.phase === "waiting-photo" && state.phase !== "waiting-photo";
      const resumed = nextRoundPhoto ? { ...state, photo: null, scores: null, round: state.round + 1 } : state;
      return resyncPhase(resumed, action.data.phase, action.data);
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
