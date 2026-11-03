import {
  GamePausedData, GameResumedData, GameStateSnapshot, HoldEndData, HoldResumeData, Player, ResyncTiming, RoundRevealData,
  RoundScoresData, RoundStartData, ScoreRound, ServerPhase, WaitingPhotoData,
} from "../models/interfaces";

// ── Round view: what the game screen shows of the server's current phase (see Server/GAME_FLOW.md) ──

/** A player who left the room during the round in play, and their place among the round's answer options */
export interface RoundLeaver {
  player: Player;
  index: number;
}

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
  /**
   * The server says no hold can start any more this round: its holds are used up (`holdsLeft` 0) or the scoreboard is
   * down to its last moments (`hold-closed`). The hold button is greyed out
   */
  noHoldsLeft: boolean;
  /**
   * Players who left during the round in play: still its answer options until the next photo wait (DEC-038). One of
   * them may be the photo's owner, who stays the answer, and the app can't tell which (secret until the reveal)
   */
  leavers: readonly RoundLeaver[];
  /** The game's number of rounds as the server sent it (round-scores, snapshot); 0 until then */
  totalRounds: number;
  /**
   * The server's number of the game this screen shows: game-started's, when the lobby opened the screen with it
   * (roundViewOfGame), then every waiting-photo and snapshot of a started game; NO_GAME_NUMBER until one is known
   */
  gameNumber: number;
}

/** No game number seen yet; the server's numbers start at 1 */
export const NO_GAME_NUMBER = 0;

export const initialRoundView: RoundView = {
  photo: null, round: 0, phase: null, phaseDuration: 0, phaseTotal: 0, phaseKey: 0, correctAnswer: "", scores: null,
  mySelection: "", gameHeld: false, pressing: false, noHoldsLeft: false, leavers: [], totalRounds: 0,
  gameNumber: NO_GAME_NUMBER,
};

/** The game screen's view before game `gameNumber`'s first event (NO_GAME_NUMBER: a game not known yet) */
export const roundViewOfGame = (gameNumber: number): RoundView => ({ ...initialRoundView, gameNumber });

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
  | { type: "player-left"; leaver: RoundLeaver }
  | { type: "pressing"; pressing: boolean }
  | { type: "hold-start" }
  | { type: "hold-end"; data: HoldEndData }
  | { type: "hold-resume"; data: HoldResumeData }
  | { type: "hold-closed" }
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

/** Leaves the previous round: no answer, scores, pick, hold or leavers left over (a new round has all its holds) */
const PER_ROUND_RESET = {
  correctAnswer: "", scores: null, mySelection: "", gameHeld: false, pressing: false, noHoldsLeft: false, leavers: [],
} as const;

/** A round in play, its photo on screen: answering, reveal or scores */
export const inRoundPhase = (phase: ServerPhase | null) => phase === "answering" || phase === "reveal" || phase === "scores";

/** The snapshot shows a round in play (answering/reveal/scores) with its photo */
const showsRound = (snap: GameStateSnapshot) => inRoundPhase(snap.phase) && !!snap.photo;

/**
 * `waiting-photo` (and a `game-state` in that phase, or a resume into it from scores): leave the previous round
 * (PER_ROUND_RESET, photo) and show the waiting screen for round `round`, with the server's `duration` (of the wait's
 * full `total`) for the progress bar.
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

/**
 * The round's options that are no longer in the room, from the snapshot (the server's list: it covers a `player-left`
 * this screen missed while offline, or one from before the app restarted)
 */
const snapshotLeavers = (snap: GameStateSnapshot): RoundLeaver[] =>
  snap.roundOptions
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => !snap.players.some((p) => p.username === player.username));

/** Renders the `game-state` snapshot a rejoining player receives (the pick shown: see snapshotSelection) */
const applySnapshot = (state: RoundView, snap: GameStateSnapshot, serverUrl: string): RoundView => {
  if (!snap.started) return { ...state, pressing: false, gameHeld: false };
  const held = {
    ...state, pressing: false, gameHeld: snap.held, noHoldsLeft: snap.holdsLeft === 0, totalRounds: snap.totalRounds,
    gameNumber: snap.gameNumber,
  };

  if (showsRound(snap)) {
    const photo = `${serverUrl}${snap.photo}`;
    const sameRound = snap.round === state.round && photo === state.photo;
    return {
      ...resyncPhase(held, snap.phase, snap),
      photo, round: snap.round, correctAnswer: snap.correctAnswer ?? "",
      scores: snap.phase === "scores" ? snap.scores : null,
      mySelection: snapshotSelection(state, snap, sameRound),
      leavers: snapshotLeavers(snap),
    };
  }

  // Waiting for the next photo: same screen as `waiting-photo` (snapshot round is the last played one)
  if (snap.phase === "waiting-photo") return waitForPhoto(held, snap.round + 1, snap.duration, snap.phaseTotal);

  // Ready phase: back to the "are you ready" screen until the first round, under the server's hold
  return { ...held, ...PER_ROUND_RESET, gameHeld: snap.held, photo: null, phase: null };
};

// ── A snapshot of the next game (EXP-302, EXP-318) ──

/**
 * The `game-state` snapshot is of another game than the one this screen shows: the game shown ended while I was away
 * (its game-over was lost) and the host already started the next one, which has the room's next game number. A
 * not-started snapshot is the end of a game (its final scores). A screen opened from game-started knows its number
 * from the start (EXP-384); one that knows none yet (opened on a game in progress) takes the snapshot's game as its own.
 */
export const isAnotherGame = (state: RoundView, snap: GameStateSnapshot): boolean =>
  snap.started && state.gameNumber !== NO_GAME_NUMBER && snap.gameNumber !== state.gameNumber;

export const roundReducer = (state: RoundView, action: RoundAction): RoundView => {
  switch (action.type) {
    case "waiting-photo":
      return { ...waitForPhoto(state, action.data.round, action.data.duration), gameNumber: action.data.gameNumber };
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
      return {
        ...startPhase(state, "scores", action.data.duration), scores: action.data.scores, round: action.data.round,
        totalRounds: action.data.totalRounds,
      };
    case "pick":
      return { ...state, mySelection: action.guess };
    // Left during the round in play: kept as an option until the next photo wait (before it, they simply go)
    case "player-left":
      return state.photo && inRoundPhase(state.phase) ? { ...state, leavers: [...state.leavers, action.leaver] } : state;
    case "pressing":
      return { ...state, pressing: action.pressing };
    case "hold-start":
      return { ...state, gameHeld: true };
    // The end of a hold leaves `pressing` (my finger) alone: it may be the answer to a release of mine that arrives
    // after I pressed again, and that new press must still send its release. A release after a hold the server ended
    // by itself is ignored by the server (I hold nothing).
    case "hold-end":
      return { ...state, gameHeld: false, noHoldsLeft: action.data.holdsLeft === 0 };
    // Too little of the scoreboard is left for a hold: no hold can start any more, as when they are used up
    case "hold-closed":
      return { ...state, noHoldsLeft: true };
    case "game-paused":
      return { ...state, gameHeld: false, pressing: false };
    // The held phase continues with the remaining time
    case "hold-resume":
      return { ...resyncPhase(state, action.data.phase, action.data), gameHeld: false };
    // The server's phase goes on, also when this screen still showed an earlier one (the game-state that follows a
    // rejoin fills in what that phase shows)
    case "game-resumed": {
      // Paused between rounds (after scores): the next round's photo is awaited now, as after a waiting-photo
      const nextRoundPhoto = action.data.phase === "waiting-photo" && state.phase !== "waiting-photo";
      if (nextRoundPhoto) return waitForPhoto(state, state.round + 1, action.data.duration, action.data.phaseTotal);
      return resyncPhase(state, action.data.phase, action.data);
    }
    case "game-state":
      return applySnapshot(state, action.snap, action.serverUrl);
  }
};

/**
 * The round's answer options: the players in the room, with those who left during the round back in their places
 * (each at its index among the options, re-inserted from the first place on, which rebuilds the order they were in)
 */
export const roundOptions = (players: Player[], leavers: readonly RoundLeaver[]): Player[] => {
  if (leavers.length === 0) return players;
  const options = [...players];
  for (const { player, index } of [...leavers].sort((a, b) => a.index - b.index)) {
    if (!options.some((p) => p.username === player.username)) options.splice(Math.min(index, options.length), 0, player);
  }
  return options;
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
