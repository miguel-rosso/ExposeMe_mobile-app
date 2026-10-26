import { GameStateSnapshot } from "../app/models/interfaces";
import {
  gameStateFollowUps, initialRoundView, isRevealedOwner, phaseElapsed, roundReducer, RoundView,
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
    const prev = view({ phaseKey: 4, correctAnswer: "alice", scores: [], mySelection: "bob", sentGuess: "bob" });
    expect(start(prev)).toEqual({
      photo: "http://srv/temp/a.jpg", round: 3, phase: "answering", phaseDuration: 10000, phaseTotal: 10000, phaseKey: 5,
      correctAnswer: "", scores: null, mySelection: "", sentGuess: "", gameHeld: false, pressing: false,
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
    state = roundReducer(state, { type: "round-reveal", data: { correctAnswer: "bob", duration: 3_000 } });
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
});

// ── game-state ───────────────────────────────────────────

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  phase: "answering",
  round: 3,
  totalRounds: 10,
  photo: "/temp/1-a.jpg",
  correctAnswer: null,
  duration: 4200,
  held: false,
  pause: null,
  scores: [{ username: "alice", points: 2, isHost: true, lastAnswerCorrect: false, lastGuess: "" }],
  players: [],
  ...over,
});

/** The screen before the reconnect showed round 3 with this photo, and my pick "carol" (sent) */
const shown = (over: Partial<RoundView> = {}) =>
  view({ round: 3, photo: "http://srv/temp/1-a.jpg", phase: "answering", mySelection: "carol", sentGuess: "carol", ...over });

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

  // EXP-148: a pick made while offline never reached the server; once answers are frozen it must not be coloured
  it("clears a pick that was never sent when a same-round snapshot is past answering", () => {
    const unsent = shown({ sentGuess: "" });
    for (const phase of ["reveal", "scores"] as const) {
      const snap = snapshot({ phase, correctAnswer: "alice" });
      expect(applyGameState(snap, "http://srv", unsent).state.mySelection).toBe("");
      expect(applyGameState(snap, "http://srv", shown()).state.mySelection).toBe("carol");
    }
    // Still answering: kept (and re-sent by the screen)
    expect(applyGameState(snapshot(), "http://srv", unsent).state.mySelection).toBe("carol");
  });

  // EXP-227: a reveal snapshot colours the same pick the live round-reveal would
  it("shows the last pick sent in a reveal snapshot, and nothing of mine for a round played while away", () => {
    const tappedLate = shown({ mySelection: "alice", sentGuess: "carol" });
    const reveal = snapshot({ phase: "reveal", correctAnswer: "alice" });
    expect(applyGameState(reveal, "http://srv", tappedLate).state.mySelection).toBe("carol");
    const otherRound = shown({ round: 2, photo: "http://srv/temp/0-b.jpg" });
    expect(applyGameState(reveal, "http://srv", otherRound).state.mySelection).toBe("");
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
  const answering = view({ round: 2, photo: "http://srv/temp/a.jpg", phase: "answering", phaseKey: 7, mySelection: "bob", sentGuess: "bob" });

  it("reveal and scores restart the progress bar with the server's duration", () => {
    const reveal = roundReducer(answering, { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000 } });
    expect(reveal).toMatchObject({ phase: "reveal", correctAnswer: "alice", phaseDuration: 3_000, phaseKey: 8, mySelection: "bob" });
    const scores = roundReducer(reveal, {
      type: "round-scores", data: { scores: [], round: 2, totalRounds: 5, duration: 5_000 },
    });
    expect(scores).toMatchObject({ phase: "scores", scores: [], round: 2, phaseDuration: 5_000, phaseKey: 9 });
  });

  // EXP-227: the reveal colours the guess that counted, not a later local tap
  it("the reveal shows the last pick sent", () => {
    const sent = roundReducer({ ...answering, mySelection: "", sentGuess: "" }, { type: "pick", guess: "carol" });
    const late = roundReducer(roundReducer(sent, { type: "pick-sent", guess: "carol" }), { type: "pick", guess: "alice" });
    const reveal = roundReducer(late, { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000 } });
    expect(reveal.mySelection).toBe("carol");
  });

  it("hold-resume keeps the phase and restarts its bar; hold-end and a pause release the hold", () => {
    const held = roundReducer({ ...answering, phase: "scores", pressing: true }, { type: "hold-start" });
    expect(held.gameHeld).toBe(true);
    expect(roundReducer(held, { type: "hold-resume", data: { phase: "scores", duration: 2_000 } })).toMatchObject({
      phase: "scores", phaseDuration: 2_000, phaseKey: 8, gameHeld: false, pressing: false,
    });
    expect(roundReducer(held, { type: "hold-end" })).toMatchObject({ gameHeld: false, pressing: false });
    expect(roundReducer(held, { type: "game-paused" })).toMatchObject({ gameHeld: false, pressing: false });
  });

  it("resuming a pause taken after scores waits for the next round's photo", () => {
    const scores = { ...answering, phase: "scores" as const, scores: [], correctAnswer: "alice" };
    expect(roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 1_500 } })).toMatchObject({
      photo: null, scores: null, phase: "waiting-photo", round: 3, phaseDuration: 1_500, phaseKey: 8,
    });
    // Same phase resumed: only the remaining time changes
    expect(roundReducer(answering, { type: "game-resumed", data: { phase: "answering", duration: 4_000 } })).toEqual({
      ...answering, phaseDuration: 4_000, phaseTotal: 4_000, phaseKey: 8,
    });
  });
});

// ── Progress bar after a resume or reconnect (EXP-080 / EXP-099) ──

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
    const resumed = roundReducer(paused, { type: "game-resumed", data: { phase: "answering", duration: 2_000 } });
    expect(resumed).toMatchObject({ phaseDuration: 2_000, phaseTotal: 8_000, phaseKey: 5 });
    expect(phaseElapsed(resumed)).toBe(0.75);
    // A second pause in the same phase still measures against the full duration
    const again = roundReducer(roundReducer(resumed, { type: "game-paused" }), {
      type: "game-resumed", data: { phase: "answering", duration: 1_000 },
    });
    expect(phaseElapsed(again)).toBe(0.875);
  });

  it("a resume with more time than was left (the server's minimum) starts the bar further back, never before empty", () => {
    const resumed = roundReducer(roundStart(), { type: "game-resumed", data: { phase: "answering", duration: 9_000 } });
    expect(resumed.phaseTotal).toBe(9_000);
    expect(phaseElapsed(resumed)).toBe(0);
  });

  it("a hold released in scores continues the scores bar", () => {
    const scores = roundReducer(roundStart(), {
      type: "round-scores", data: { scores: [], round: 3, totalRounds: 10, duration: 6_000 },
    });
    const held = roundReducer(scores, { type: "hold-start" });
    const resumed = roundReducer(held, { type: "hold-resume", data: { phase: "scores", duration: 1_500 } });
    expect(phaseElapsed(resumed)).toBe(0.75);
  });

  it("a pause between rounds resumes a new photo wait: its bar starts empty", () => {
    const scores = roundReducer(roundStart(), {
      type: "round-scores", data: { scores: [], round: 3, totalRounds: 10, duration: 6_000 },
    });
    const resumed = roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 15_000 } });
    expect(resumed.phase).toBe("waiting-photo");
    expect(phaseElapsed(resumed)).toBe(0);
  });

  it("a snapshot of the phase on screen continues its bar; one of another phase or round starts it empty", () => {
    const answering = roundStart();
    const same = applyGameState(snapshot({ duration: 6_000 }), "http://srv", answering).state;
    expect(phaseElapsed(same)).toBe(0.25);
    const reveal = applyGameState(snapshot({ phase: "reveal", correctAnswer: "alice", duration: 1_000 }), "http://srv", answering);
    expect(phaseElapsed(reveal.state)).toBe(0);
    const otherRound = applyGameState(snapshot({ round: 4, photo: "/temp/2-b.jpg", duration: 6_000 }), "http://srv", answering);
    expect(phaseElapsed(otherRound.state)).toBe(0);
  });

  it("a snapshot of the same photo wait continues its bar; a wait for another round starts it empty", () => {
    const waiting = roundReducer(view(), { type: "waiting-photo", data: { round: 4, duration: 15_000 } });
    const same = applyGameState(snapshot({ phase: "waiting-photo", photo: null, round: 3, duration: 5_000 }), "", waiting);
    expect(same.state).toMatchObject({ phase: "waiting-photo", round: 4, phaseDuration: 5_000, phaseTotal: 15_000 });
    expect(phaseElapsed(same.state)).toBeCloseTo(2 / 3);
    const next = applyGameState(snapshot({ phase: "waiting-photo", photo: null, round: 4, duration: 5_000 }), "", waiting);
    expect(phaseElapsed(next.state)).toBe(0);
  });
});
