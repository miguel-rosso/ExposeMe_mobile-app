import { GameStateSnapshot } from "../app/models/interfaces";
import {
  gameStateFollowUps, initialRoundView, isRevealedOwner, phaseElapsed, RoundAction, roundReducer, RoundView,
} from "../app/utils/roundState";

// Ported from the applyRoundStart / applyWaitingPhoto / applyGameState setter tests (EXP-215): same expectations,
// now on the round reducer's next state.

const view = (over: Partial<RoundView> = {}): RoundView => ({ ...initialRoundView, ...over });

// ── round-start ──────────────────────────────────────────

describe("round-start (EXP-001)", () => {
  const data = { photo: "/temp/a.jpg", round: 3, duration: 10000 };
  const start = (state: RoundView, d = data) => roundReducer(state, { type: "round-start", data: d, serverUrl: "http://srv" });

  it("does not throw and clears hold state left over from the previous round", () => {
    const prev = view({ gameHeld: true, pressing: true });
    expect(() => start(prev)).not.toThrow();
    expect(start(prev)).toMatchObject({ gameHeld: false, pressing: false });
  });

  it("sets the new round photo/phase and resets per-round answer state", () => {
    const prev = view({ phaseKey: 4, correctAnswer: "alice", scores: [], mySelection: "bob" });
    expect(start(prev)).toEqual({
      photo: "http://srv/temp/a.jpg", round: 3, phase: "answering", phaseDuration: 10000, phaseTotal: 10000, phaseKey: 5,
      correctAnswer: "", scores: null, mySelection: "", gameHeld: false, pressing: false,
    });
  });

  // EXP-252: round-start tells nobody whose photo it is, the owner included: the round view has no owner field
  it("keeps nothing about whose photo it is, even if a payload carried an owner flag", () => {
    const next = start(view(), { ...data, isOwner: true } as typeof data);
    expect(next).not.toHaveProperty("isOwner");
    expect(isRevealedOwner(next.correctAnswer, "bob")).toBe(false);
  });
});

// ── whose photo it was (EXP-252) ─────────────────────────

describe("isRevealedOwner", () => {
  it("is true only once the revealed answer is my own username", () => {
    expect(isRevealedOwner("bob", "bob")).toBe(true);
    expect(isRevealedOwner("alice", "bob")).toBe(false);
    expect(isRevealedOwner("", "bob")).toBe(false); // not revealed yet
    expect(isRevealedOwner("", "")).toBe(false); // no username known
    expect(isRevealedOwner("bob", undefined)).toBe(false);
  });

  it("follows the round: true after the reveal of my photo, false again when the next round starts", () => {
    let state = roundReducer(view(), { type: "round-start", data: { photo: "/temp/a.jpg", round: 1, duration: 7_700 }, serverUrl: "" });
    expect(isRevealedOwner(state.correctAnswer, "bob")).toBe(false);
    state = roundReducer(state, { type: "round-reveal", data: { correctAnswer: "bob", duration: 3_000, yourGuess: "" } });
    expect(isRevealedOwner(state.correctAnswer, "bob")).toBe(true);
    state = roundReducer(state, { type: "waiting-photo", data: { round: 2, duration: 15_000 } });
    expect(isRevealedOwner(state.correctAnswer, "bob")).toBe(false);
  });
});

// ── waiting-photo ────────────────────────────────────────

describe("waiting-photo", () => {
  it("leaves the previous round and paints the server's wait", () => {
    const prev = view({ photo: "http://srv/temp/a.jpg", round: 3, phase: "scores", scores: [], mySelection: "bob" });
    const next = roundReducer(prev, { type: "waiting-photo", data: { round: 4, duration: 15_000 } });
    expect(next).toMatchObject({
      photo: null, phase: "waiting-photo", round: 4, phaseDuration: 15_000, scores: null, mySelection: "",
    });
  });

  // EXP-029 / DEC-035: the owner went away, the server picks another one for the same round with a new waiting-photo
  it("a new wait for the same round restarts the bar with the server's duration", () => {
    const waiting = view({ phase: "waiting-photo", round: 4, phaseDuration: 15_000, phaseKey: 6 });
    const next = roundReducer(waiting, { type: "waiting-photo", data: { round: 4, duration: 15_000 } });
    expect(next).toMatchObject({ phase: "waiting-photo", round: 4, phaseDuration: 15_000, phaseKey: 7 });
  });
});

// ── game-state ───────────────────────────────────────────

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  phase: "answering",
  round: 3,
  totalRounds: 10,
  photo: "/temp/1-a.jpg",
  correctAnswer: null,
  yourGuess: null,
  duration: 4200,
  phaseTotal: 8000,
  held: false,
  pause: null,
  scores: [{ username: "alice", points: 2, isHost: true, lastAnswerCorrect: false, lastGuess: "" }],
  players: [],
  ...over,
});

/** The screen before the reconnect showed round 3 with this photo, and my pick "carol" */
const shown = (over: Partial<RoundView> = {}) =>
  view({ round: 3, photo: "http://srv/temp/1-a.jpg", phase: "answering", mySelection: "carol", ...over });

const applyGameState = (snap: GameStateSnapshot, serverUrl: string, current: RoundView) => ({
  state: roundReducer(current, { type: "game-state", snap, serverUrl }),
  result: gameStateFollowUps(snap),
});

describe("game-state", () => {
  it("renders the current answering phase with the remaining time and keeps the guess of the same round", () => {
    const { state, result } = applyGameState(snapshot(), "http://srv", shown());
    expect(result).toEqual({ gameOver: false, sendReady: false, resendGuess: true, pause: null });
    expect(state).toMatchObject({
      photo: "http://srv/temp/1-a.jpg", phase: "answering", phaseDuration: 4200, mySelection: "carol",
    });
  });

  // EXP-252: the snapshot names the owner only from the reveal on (correctAnswer), the same for everyone
  it("knows the photo was mine only from a reveal/scores snapshot naming me", () => {
    expect(isRevealedOwner(applyGameState(snapshot(), "http://srv", shown()).state.correctAnswer, "bob")).toBe(false);
    const scores = applyGameState(snapshot({ phase: "scores", correctAnswer: "bob" }), "http://srv", shown());
    expect(isRevealedOwner(scores.state.correctAnswer, "bob")).toBe(true);
    const waiting = applyGameState(snapshot({ phase: "waiting-photo", photo: null }), "", scores.state);
    expect(isRevealedOwner(waiting.state.correctAnswer, "bob")).toBe(false);
  });

  it("clears the guess when the round changed while away", () => {
    const { state } = applyGameState(snapshot(), "http://srv", shown({ round: 2, photo: "http://srv/temp/0-b.jpg" }));
    expect(state.mySelection).toBe("");
  });

  // EXP-148: answers freeze when answering ends, so a guess is only (re)sent in answering, never in reveal
  it("never asks to send the guess in reveal, and shows scores in scores", () => {
    const reveal = applyGameState(snapshot({ phase: "reveal", correctAnswer: "alice" }), "", shown());
    expect(reveal.result.resendGuess).toBe(false);
    expect(reveal.state.correctAnswer).toBe("alice");
    const scores = applyGameState(snapshot({ phase: "scores", correctAnswer: "alice" }), "", shown());
    expect(scores.state.scores).toEqual(snapshot().scores);
  });

  // EXP-148 / EXP-230: once answers are frozen the snapshot's yourGuess (what the server recorded) is coloured, not
  // my local pick: one made offline, or sent too late, never counted
  it("shows the server's recorded answer in a reveal/scores snapshot, whatever my local pick", () => {
    for (const phase of ["reveal", "scores"] as const) {
      const unrecorded = snapshot({ phase, correctAnswer: "alice", yourGuess: "" });
      expect(applyGameState(unrecorded, "http://srv", shown()).state.mySelection).toBe("");
      const recorded = snapshot({ phase, correctAnswer: "alice", yourGuess: "bob" });
      expect(applyGameState(recorded, "http://srv", shown()).state.mySelection).toBe("bob");
    }
    // Still answering: my pick is kept (and re-sent by the screen)
    expect(applyGameState(snapshot(), "http://srv", shown()).state.mySelection).toBe("carol");
  });

  // EXP-230: a reveal snapshot colours the same pick the live round-reveal would, also for a round I didn't see start
  it("shows the recorded answer in a reveal snapshot of a round played while away", () => {
    const otherRound = shown({ round: 2, photo: "http://srv/temp/0-b.jpg" });
    const none = snapshot({ phase: "reveal", correctAnswer: "alice", yourGuess: "" });
    expect(applyGameState(none, "http://srv", otherRound).state.mySelection).toBe("");
    const recorded = snapshot({ phase: "reveal", correctAnswer: "alice", yourGuess: "alice" });
    expect(applyGameState(recorded, "http://srv", otherRound).state.mySelection).toBe("alice");
  });

  it("shows the server's pause countdown, and clears a pause when the snapshot has none", () => {
    const pause = { duration: 299_000, waitingFor: [], pause: 2, maxPauses: 3 };
    expect(applyGameState(snapshot({ pause }), "", shown()).result.pause).toEqual(pause);
    expect(applyGameState(snapshot({ pause: null }), "", shown()).result.pause).toBeNull();
  });

  it("restores the server's hold and releases my press", () => {
    const { state } = applyGameState(snapshot({ phase: "scores", held: true }), "http://srv", shown({ pressing: true }));
    expect(state).toMatchObject({ gameHeld: true, pressing: false });
  });

  it("waiting for a photo: the waiting screen for the next round (EXP-039); ready phase: send im-ready again", () => {
    const { state, result } = applyGameState(snapshot({ phase: "waiting-photo", photo: null, duration: 9_000, held: true }), "", shown());
    expect(result.sendReady).toBe(false);
    expect(state).toMatchObject({ photo: null, phase: "waiting-photo", round: 4, phaseDuration: 9_000, gameHeld: false });
    const ready = applyGameState(snapshot({ phase: null, photo: null }), "", view());
    expect(ready.result.sendReady).toBe(true);
    expect(ready.state).toMatchObject({ photo: null, phase: null, mySelection: "" });
  });

  it("reports game over when the game ended while away", () => {
    const pause = { duration: 1_000, waitingFor: [], pause: 1, maxPauses: 3 };
    const { state, result } = applyGameState(snapshot({ started: false, phase: null, pause }), "", shown({ gameHeld: true }));
    expect(result.gameOver).toBe(true);
    expect(result.pause).toBeNull();
    expect(state.photo).toBe("http://srv/temp/1-a.jpg");
    expect(state.gameHeld).toBe(false);
  });
});

// ── Phase updates within a round ─────────────────────────

describe("reveal, scores, hold and pause", () => {
  const answering = view({ round: 2, photo: "http://srv/temp/a.jpg", phase: "answering", phaseKey: 7, mySelection: "bob" });

  it("reveal and scores restart the progress bar with the server's duration", () => {
    const reveal = roundReducer(answering, { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000, yourGuess: "bob" } });
    expect(reveal).toMatchObject({ phase: "reveal", correctAnswer: "alice", phaseDuration: 3_000, phaseKey: 8, mySelection: "bob" });
    const scores = roundReducer(reveal, {
      type: "round-scores", data: { scores: [], round: 2, totalRounds: 5, duration: 5_000 },
    });
    expect(scores).toMatchObject({ phase: "scores", scores: [], round: 2, phaseDuration: 5_000, phaseKey: 9 });
  });

  // EXP-230: the reveal colours the guess the server recorded, not my last local pick (sent too late to count)
  it("the reveal shows the answer the server recorded for me", () => {
    const late = roundReducer(roundReducer(answering, { type: "pick", guess: "carol" }), { type: "pick", guess: "alice" });
    const reveal = roundReducer(late, { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000, yourGuess: "carol" } });
    expect(reveal.mySelection).toBe("carol");
    const none = roundReducer(late, { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000, yourGuess: "" } });
    expect(none.mySelection).toBe("");
  });


  it("hold-resume keeps the phase and restarts its bar; hold-end and a pause release the hold", () => {
    const held = roundReducer({ ...answering, phase: "scores", pressing: true }, { type: "hold-start" });
    expect(held.gameHeld).toBe(true);
    expect(roundReducer(held, { type: "hold-resume", data: { phase: "scores", duration: 2_000, phaseTotal: 5_000 } })).toMatchObject({
      phase: "scores", phaseDuration: 2_000, phaseTotal: 5_000, phaseKey: 8, gameHeld: false,
    });
    expect(roundReducer(held, { type: "hold-end" })).toMatchObject({ gameHeld: false });
    expect(roundReducer(held, { type: "game-paused" })).toMatchObject({ gameHeld: false, pressing: false });
  });

  // The end of a hold may answer a release of mine that arrives after I pressed again: my finger stays down
  it("hold-resume and hold-end leave my press alone (its release must still go out)", () => {
    const pressedAgain = view({ ...answering, phase: "scores", gameHeld: true, pressing: true });
    const answered: RoundAction[] = [
      { type: "hold-resume", data: { phase: "scores", duration: 2_000, phaseTotal: 5_000 } },
      { type: "hold-end" },
    ];
    expect(answered.reduce(roundReducer, pressedAgain).pressing).toBe(true);
  });

  it("resuming a pause taken after scores waits for the next round's photo", () => {
    const scores = { ...answering, phase: "scores" as const, scores: [], correctAnswer: "alice" };
    expect(roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 1_500, phaseTotal: 1_500 } })).toMatchObject({
      photo: null, scores: null, phase: "waiting-photo", round: 3, phaseDuration: 1_500, phaseKey: 8,
    });
    // Same phase resumed: only the remaining time (of the server's phase total) changes
    expect(roundReducer(answering, { type: "game-resumed", data: { phase: "answering", duration: 4_000, phaseTotal: 7_700 } })).toEqual({
      ...answering, phaseDuration: 4_000, phaseTotal: 7_700, phaseKey: 8,
    });
  });
});

// ── Progress bar after a resume or reconnect (EXP-080 / EXP-099 / EXP-273) ──

describe("phaseElapsed: where the progress bar of a resumed phase starts", () => {
  const roundStart = (duration = 8_000) => roundReducer(view({ phaseKey: 3 }), {
    type: "round-start", data: { photo: "/temp/1-a.jpg", round: 3, duration }, serverUrl: "http://srv",
  });

  it("is 0 for a phase seen from its start", () => {
    expect(phaseElapsed(initialRoundView)).toBe(0);
    expect(phaseElapsed(roundStart())).toBe(0);
    expect(phaseElapsed(roundReducer(view(), { type: "waiting-photo", data: { round: 4, duration: 15_000 } }))).toBe(0);
  });

  it("a resumed pause continues from the fraction already gone, against the phase's full duration", () => {
    const paused = roundReducer(roundStart(), { type: "game-paused" });
    const resumed = roundReducer(paused, { type: "game-resumed", data: { phase: "answering", duration: 2_000, phaseTotal: 8_000 } });
    expect(resumed).toMatchObject({ phaseDuration: 2_000, phaseTotal: 8_000, phaseKey: 5 });
    expect(phaseElapsed(resumed)).toBe(0.75);
    // A second pause in the same phase still measures against the full duration
    const again = roundReducer(roundReducer(resumed, { type: "game-paused" }), {
      type: "game-resumed", data: { phase: "answering", duration: 1_000, phaseTotal: 8_000 },
    });
    expect(phaseElapsed(again)).toBe(0.875);
  });

  // EXP-273: the screen may still show an earlier phase (it was away when the phase changed); the server's phase and
  // its total win over the stale one
  it("game-resumed of another phase than the one on screen renders the server's phase with its total", () => {
    const resumed = roundReducer(roundStart(), { type: "game-resumed", data: { phase: "scores", duration: 2_000, phaseTotal: 5_000 } });
    expect(resumed).toMatchObject({ phase: "scores", phaseDuration: 2_000, phaseTotal: 5_000 });
    expect(phaseElapsed(resumed)).toBe(0.6);
  });

  it("a hold released in scores continues the scores bar", () => {
    const scores = roundReducer(roundStart(), {
      type: "round-scores", data: { scores: [], round: 3, totalRounds: 10, duration: 6_000 },
    });
    const held = roundReducer(scores, { type: "hold-start" });
    const resumed = roundReducer(held, { type: "hold-resume", data: { phase: "scores", duration: 1_500, phaseTotal: 6_000 } });
    expect(phaseElapsed(resumed)).toBe(0.75);
  });

  it("a pause between rounds resumes a new photo wait: the server shows it whole, its bar starts empty", () => {
    const scores = roundReducer(roundStart(), {
      type: "round-scores", data: { scores: [], round: 3, totalRounds: 10, duration: 6_000 },
    });
    const resumed = roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 1_500, phaseTotal: 1_500 } });
    expect(resumed.phase).toBe("waiting-photo");
    expect(phaseElapsed(resumed)).toBe(0);
  });

  it("a snapshot places the bar at the fraction gone of the server's phaseTotal, whatever the screen showed", () => {
    const answering = roundStart();
    expect(phaseElapsed(applyGameState(snapshot({ duration: 6_000 }), "http://srv", answering).state)).toBe(0.25);
    const reveal = applyGameState(
      snapshot({ phase: "reveal", correctAnswer: "alice", duration: 1_000, phaseTotal: 3_000 }), "http://srv", answering,
    ).state;
    expect(reveal).toMatchObject({ phase: "reveal", phaseDuration: 1_000, phaseTotal: 3_000 });
    expect(phaseElapsed(reveal)).toBeCloseTo(2 / 3);
    const otherRound = applyGameState(snapshot({ round: 4, photo: "/temp/2-b.jpg", duration: 6_000 }), "http://srv", answering);
    expect(phaseElapsed(otherRound.state)).toBe(0.25);
    const scoresFromWait = applyGameState(
      snapshot({ phase: "scores", correctAnswer: "alice", duration: 1_000, phaseTotal: 5_000 }), "http://srv",
      roundReducer(view(), { type: "waiting-photo", data: { round: 3, duration: 15_000 } }),
    );
    expect(phaseElapsed(scoresFromWait.state)).toBe(0.8);
    // Never before empty, even with a phaseTotal shorter than what is left
    const short = applyGameState(snapshot({ phase: "reveal", correctAnswer: "alice", duration: 2_000, phaseTotal: 1_000 }), "http://srv", answering);
    expect(phaseElapsed(short.state)).toBe(0);
  });

  it("a waiting-photo snapshot shows the wait for the next round, its bar at the fraction gone", () => {
    const waiting = roundReducer(view(), { type: "waiting-photo", data: { round: 4, duration: 15_000 } });
    const same = applyGameState(snapshot({ phase: "waiting-photo", photo: null, round: 3, duration: 5_000, phaseTotal: 15_000 }), "", waiting);
    expect(same.state).toMatchObject({ phase: "waiting-photo", round: 4, phaseDuration: 5_000, phaseTotal: 15_000 });
    expect(phaseElapsed(same.state)).toBeCloseTo(2 / 3);
    const fromReveal = roundReducer(roundStart(), { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000, yourGuess: "" } });
    const next = applyGameState(snapshot({ phase: "waiting-photo", photo: null, duration: 12_000, phaseTotal: 15_000 }), "", fromReveal);
    expect(next.state).toMatchObject({ phase: "waiting-photo", round: 4, photo: null, correctAnswer: "" });
    expect(phaseElapsed(next.state)).toBeCloseTo(0.2);
  });
});
