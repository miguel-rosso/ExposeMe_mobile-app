import { GameStateSnapshot, Player } from "../app/models/interfaces";
import {
  gameStateFollowUps, initialRoundView, isAnotherGame, isRevealedOwner, NO_GAME_NUMBER, phaseElapsed, RoundAction, roundOptions,
  roundReducer, RoundView, roundViewOfGame,
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
      correctAnswer: "", scores: null, mySelection: "", gameHeld: false, pressing: false, noHoldsLeft: false, leavers: [],
      totalRounds: 0, gameNumber: 0,
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
    state = roundReducer(state, { type: "waiting-photo", data: { round: 2, duration: 15_000, gameNumber: 1 } });
    expect(isRevealedOwner(state.correctAnswer, "bob")).toBe(false);
  });
});

// ── waiting-photo ────────────────────────────────────────

describe("waiting-photo", () => {
  it("leaves the previous round and paints the server's wait", () => {
    const prev = view({ photo: "http://srv/temp/a.jpg", round: 3, phase: "scores", scores: [], mySelection: "bob" });
    const next = roundReducer(prev, { type: "waiting-photo", data: { round: 4, duration: 15_000, gameNumber: 1 } });
    expect(next).toMatchObject({
      photo: null, phase: "waiting-photo", round: 4, phaseDuration: 15_000, scores: null, mySelection: "",
    });
  });

  // EXP-029 / DEC-035: the owner went away, the server picks another one for the same round with a new waiting-photo
  it("a new wait for the same round restarts the bar with the server's duration", () => {
    const waiting = view({ phase: "waiting-photo", round: 4, phaseDuration: 15_000, phaseKey: 6 });
    const next = roundReducer(waiting, { type: "waiting-photo", data: { round: 4, duration: 15_000, gameNumber: 1 } });
    expect(next).toMatchObject({ phase: "waiting-photo", round: 4, phaseDuration: 15_000, phaseKey: 7 });
  });
});

// ── game-state ───────────────────────────────────────────

const snapshot = (over: Partial<GameStateSnapshot> = {}): GameStateSnapshot => ({
  started: true,
  gameNumber: 1,
  phase: "answering",
  round: 3,
  totalRounds: 10,
  photo: "/temp/1-a.jpg",
  correctAnswer: null,
  yourGuess: null,
  duration: 4200,
  phaseTotal: 8000,
  held: false,
  holdsLeft: 3,
  pause: null,
  scores: [{ username: "alice", points: 2, isHost: true, lastAnswerCorrect: false, lastGuess: "" }],
  players: [],
  roundOptions: [],
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

  // EXP-235: the ready phase leaves everything of a round shown before, its phase bar untouched; the server's hold wins
  it("a ready-phase snapshot leaves the round shown before and keeps the bar's timing", () => {
    const prev = shown({
      phase: "scores", correctAnswer: "alice", scores: [], gameHeld: true, pressing: true,
      phaseDuration: 5_000, phaseTotal: 5_000, phaseKey: 9,
    });
    const ready = applyGameState(snapshot({ phase: null, photo: null }), "", prev).state;
    expect(ready).toEqual({
      ...prev, photo: null, phase: null, correctAnswer: "", scores: null, mySelection: "", gameHeld: false, pressing: false,
      totalRounds: 10, gameNumber: 1,
    });
    expect(applyGameState(snapshot({ phase: null, photo: null, held: true }), "", prev).state.gameHeld).toBe(true);
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
    expect(roundReducer(held, { type: "hold-end", data: { holdsLeft: 2 } })).toMatchObject({ gameHeld: false });
    expect(roundReducer(held, { type: "game-paused" })).toMatchObject({ gameHeld: false, pressing: false });
  });

  // The end of a hold may answer a release of mine that arrives after I pressed again: my finger stays down
  it("hold-resume and hold-end leave my press alone (its release must still go out)", () => {
    const pressedAgain = view({ ...answering, phase: "scores", gameHeld: true, pressing: true });
    const answered: RoundAction[] = [
      { type: "hold-resume", data: { phase: "scores", duration: 2_000, phaseTotal: 5_000 } },
      { type: "hold-end", data: { holdsLeft: 2 } },
    ];
    expect(answered.reduce(roundReducer, pressedAgain).pressing).toBe(true);
  });

  // EXP-176: the server says when the round's holds are used up; the app doesn't count them itself
  it("hold-end with no holds left greys the button out until the next round", () => {
    const scores = view({ ...answering, phase: "scores", gameHeld: true });
    expect(roundReducer(scores, { type: "hold-end", data: { holdsLeft: 1 } }).noHoldsLeft).toBe(false);
    const usedUp = roundReducer(scores, { type: "hold-end", data: { holdsLeft: 0 } });
    expect(usedUp).toMatchObject({ gameHeld: false, noHoldsLeft: true });
    // A pause or a resume doesn't give them back; the next round does
    expect(roundReducer(usedUp, { type: "game-paused" }).noHoldsLeft).toBe(true);
    expect(roundReducer(usedUp, { type: "hold-resume", data: { phase: "scores", duration: 1_500, phaseTotal: 5_000 } }).noHoldsLeft).toBe(true);
    expect(roundReducer(usedUp, { type: "waiting-photo", data: { round: 3, duration: 15_000, gameNumber: 1 } }).noHoldsLeft).toBe(false);
    const next = roundReducer(usedUp, { type: "round-start", data: { photo: "/temp/b.jpg", round: 3, duration: 7_700 }, serverUrl: "" });
    expect(next.noHoldsLeft).toBe(false);
  });

  // EXP-354: the server says when the running scoreboard is too short for a hold; the app keeps no timer for it
  it("hold-closed greys the button out until the next round, leaving the hold and my press alone", () => {
    const scores = view({ ...answering, phase: "scores", pressing: true });
    const closed = roundReducer(scores, { type: "hold-closed" });
    expect(closed).toEqual({ ...scores, noHoldsLeft: true });
    expect(roundReducer(closed, { type: "waiting-photo", data: { round: 3, duration: 15_000, gameNumber: 1 } }).noHoldsLeft).toBe(false);
  });

  it("a snapshot tells whether the round's holds are used up", () => {
    const scoresSnap = (holdsLeft: number) => snapshot({ phase: "scores", correctAnswer: "bob", holdsLeft });
    expect(roundReducer(view(), { type: "game-state", snap: scoresSnap(0), serverUrl: "" }).noHoldsLeft).toBe(true);
    expect(roundReducer(view({ noHoldsLeft: true }), { type: "game-state", snap: scoresSnap(2), serverUrl: "" }).noHoldsLeft).toBe(false);
  });

  it("resuming a pause taken after scores waits for the next round's photo", () => {
    const scores = { ...answering, phase: "scores" as const, scores: [], correctAnswer: "alice" };
    expect(roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 1_500, phaseTotal: 1_500 } })).toMatchObject({
      photo: null, scores: null, phase: "waiting-photo", round: 3, phaseDuration: 1_500, phaseKey: 8,
    });
    // Already waiting for that photo: only the remaining time changes, the round stays
    const waiting = view({ phase: "waiting-photo", round: 3, phaseKey: 4 });
    expect(roundReducer(waiting, { type: "game-resumed", data: { phase: "waiting-photo", duration: 5_000, phaseTotal: 15_000 } })).toEqual({
      ...waiting, phaseDuration: 5_000, phaseTotal: 15_000, phaseKey: 5,
    });
    // Same phase resumed: only the remaining time (of the server's phase total) changes
    expect(roundReducer(answering, { type: "game-resumed", data: { phase: "answering", duration: 4_000, phaseTotal: 7_700 } })).toEqual({
      ...answering, phaseDuration: 4_000, phaseTotal: 7_700, phaseKey: 8,
    });
  });

  // EXP-235: the resume enters the next round's wait, as the live waiting-photo would: nothing of the round just
  // scored (its answer, my pick, a press) is carried into the next one
  it("a resume into the next round's photo wait leaves the scored round, as waiting-photo does", () => {
    const scores = view({
      ...answering, phase: "scores", scores: [], correctAnswer: "alice", pressing: true, gameNumber: 1,
    });
    const resumed = roundReducer(scores, { type: "game-resumed", data: { phase: "waiting-photo", duration: 1_500, phaseTotal: 1_500 } });
    expect(resumed).toEqual(roundReducer(scores, { type: "waiting-photo", data: { round: 3, duration: 1_500, gameNumber: 1 } }));
    expect(resumed).toMatchObject({ correctAnswer: "", mySelection: "", pressing: false });
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
    expect(phaseElapsed(roundReducer(view(), { type: "waiting-photo", data: { round: 4, duration: 15_000, gameNumber: 1 } }))).toBe(0);
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
      roundReducer(view(), { type: "waiting-photo", data: { round: 3, duration: 15_000, gameNumber: 1 } }),
    );
    expect(phaseElapsed(scoresFromWait.state)).toBe(0.8);
    // Never before empty, even with a phaseTotal shorter than what is left
    const short = applyGameState(snapshot({ phase: "reveal", correctAnswer: "alice", duration: 2_000, phaseTotal: 1_000 }), "http://srv", answering);
    expect(phaseElapsed(short.state)).toBe(0);
  });

  it("a waiting-photo snapshot shows the wait for the next round, its bar at the fraction gone", () => {
    const waiting = roundReducer(view(), { type: "waiting-photo", data: { round: 4, duration: 15_000, gameNumber: 1 } });
    const same = applyGameState(snapshot({ phase: "waiting-photo", photo: null, round: 3, duration: 5_000, phaseTotal: 15_000 }), "", waiting);
    expect(same.state).toMatchObject({ phase: "waiting-photo", round: 4, phaseDuration: 5_000, phaseTotal: 15_000 });
    expect(phaseElapsed(same.state)).toBeCloseTo(2 / 3);
    const fromReveal = roundReducer(roundStart(), { type: "round-reveal", data: { correctAnswer: "alice", duration: 3_000, yourGuess: "" } });
    const next = applyGameState(snapshot({ phase: "waiting-photo", photo: null, duration: 12_000, phaseTotal: 15_000 }), "", fromReveal);
    expect(next.state).toMatchObject({ phase: "waiting-photo", round: 4, photo: null, correctAnswer: "" });
    expect(phaseElapsed(next.state)).toBeCloseTo(0.2);
  });
});

// ── players leaving during a round (EXP-301, DEC-038) ────

describe("players who leave during a round", () => {
  const player = (username: string): Player => ({
    username, points: 0, isHost: false, connected: true, lastGuess: "", lastAnswerCorrect: false,
  });
  const [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map(player);
  const left = (state: RoundView, p: Player, index: number) =>
    roundReducer(state, { type: "player-left", leaver: { player: p, index } });
  const answering = () =>
    roundReducer(view(), { type: "round-start", data: { photo: "/temp/a.jpg", round: 2, duration: 7_700 }, serverUrl: "" });

  it("keeps them, and my pick on them, through the reveal and scores, until the next photo wait", () => {
    let state = roundReducer(answering(), { type: "pick", guess: "carol" });
    state = left(state, carol, 2);
    expect(state).toMatchObject({ mySelection: "carol", leavers: [{ player: carol, index: 2 }] });
    state = roundReducer(state, { type: "round-reveal", data: { correctAnswer: "carol", duration: 3_000, yourGuess: "carol" } });
    state = left(state, alice, 0);
    state = roundReducer(state, { type: "round-scores", data: { scores: [], round: 2, totalRounds: 5, duration: 5_000 } });
    expect(state.leavers.map((l) => l.player.username)).toEqual(["carol", "alice"]);
    expect(roundReducer(state, { type: "waiting-photo", data: { round: 3, duration: 15_000, gameNumber: 1 } }).leavers).toEqual([]);
  });

  it("does not keep a player who left between rounds", () => {
    const waiting = roundReducer(view(), { type: "waiting-photo", data: { round: 1, duration: 15_000, gameNumber: 1 } });
    expect(left(waiting, carol, 2).leavers).toEqual([]);
    expect(left(view(), carol, 2).leavers).toEqual([]); // ready phase
  });

  // The server's roundOptions are the source: they cover a player-left this screen never got (offline, app restarted)
  it("takes them from a rejoin snapshot's roundOptions, also with no player-left seen", () => {
    const round = { phase: "answering" as const, round: 2, photo: "/temp/a.jpg", players: [alice, bob, dave] };
    const snap = snapshot({ ...round, roundOptions: [alice, bob, carol, dave] });
    expect(applyGameState(snap, "", answering()).state.leavers).toEqual([{ player: carol, index: 2 }]);
    expect(applyGameState(snap, "", view()).state.leavers).toEqual([{ player: carol, index: 2 }]); // app restarted
    // Nobody left: none, whatever this screen had seen
    const none = snapshot({ ...round, players: [alice, bob, carol, dave], roundOptions: [alice, bob, carol, dave] });
    expect(applyGameState(none, "", left(answering(), carol, 2)).state.leavers).toEqual([]);
  });

  it("roundOptions puts them back in their places among the round's options", () => {
    // [alice, bob, carol, dave]: bob (index 1) and dave (index 3) left, in either order
    const leavers = [{ player: dave, index: 3 }, { player: bob, index: 1 }];
    expect(roundOptions([alice, carol], leavers)).toEqual([alice, bob, carol, dave]);
    const players = [alice, bob];
    expect(roundOptions(players, [])).toBe(players);
    expect(roundOptions([alice, bob], [{ player: bob, index: 1 }])).toEqual([alice, bob]); // never twice
  });
});

// ── A snapshot of the next game (EXP-302) ────────────────

describe("the game's number of rounds (EXP-302)", () => {
  it("is the server's: from round-scores and from a snapshot of a started game", () => {
    const scores = roundReducer(view(), {
      type: "round-scores", data: { scores: [], round: 2, totalRounds: 15, duration: 5_000 },
    });
    expect(scores.totalRounds).toBe(15);
    for (const over of [{}, { phase: "waiting-photo" as const, photo: null }, { phase: null, photo: null }]) {
      expect(applyGameState(snapshot({ ...over, totalRounds: 20 }), "", view()).state.totalRounds).toBe(20);
    }
    // A game-over snapshot keeps the count of the game that ended
    expect(applyGameState(snapshot({ started: false, totalRounds: 20 }), "", scores).state.totalRounds).toBe(15);
  });
});

// EXP-318: the server numbers each game of the room; the screen keeps the number of the game it shows
describe("the game this screen shows (EXP-318)", () => {
  it("is the number of its first waiting-photo or snapshot of a started game, unknown (0) before", () => {
    expect(initialRoundView.gameNumber).toBe(0);
    const waiting = roundReducer(view(), { type: "waiting-photo", data: { round: 1, duration: 15_000, gameNumber: 4 } });
    expect(waiting.gameNumber).toBe(4);
    for (const over of [{}, { phase: "waiting-photo" as const, photo: null }, { phase: null, photo: null }]) {
      expect(applyGameState(snapshot({ ...over, gameNumber: 7 }), "", view()).state.gameNumber).toBe(7);
    }
    // A game-over snapshot is of the game that ended: nothing to take from it
    expect(applyGameState(snapshot({ started: false, gameNumber: 7 }), "", waiting).state.gameNumber).toBe(4);
  });
});

describe("isAnotherGame (EXP-318)", () => {
  // The screen showed game 1
  const ofGame1 = (over: Partial<RoundView> = {}) => view({ gameNumber: 1, ...over });
  const another = (snap: GameStateSnapshot, state = ofGame1({ round: 10, phase: "scores", photo: "http://srv/temp/9-z.jpg" })) =>
    isAnotherGame(state, snap);

  it("a started snapshot with another game number, wherever that game is", () => {
    expect(another(snapshot({ gameNumber: 2, phase: null, round: 0, photo: null }))).toBe(true);
    expect(another(snapshot({ gameNumber: 2, phase: "scores", round: 10, photo: "/temp/9-z.jpg" }))).toBe(true);
  });

  // What the round-progress heuristic of EXP-302 could not tell: game 1 ended in round 1's photo wait, and game 2,
  // with the same number of rounds, is at that same wait when I come back
  it("the next game at the very point where a game that ended early stopped", () => {
    const firstWait = roundReducer(view({ totalRounds: 10 }), { type: "waiting-photo", data: { round: 1, duration: 15_000, gameNumber: 1 } });
    expect(another(snapshot({ gameNumber: 2, phase: "waiting-photo", round: 0, photo: null }), firstWait)).toBe(true);
    expect(another(snapshot({ gameNumber: 1, phase: "waiting-photo", round: 0, photo: null }), firstWait)).toBe(false);
  });

  it("is never this game's own snapshot, whatever its phase, nor its end", () => {
    expect(another(snapshot({ gameNumber: 1, phase: "scores", round: 10, photo: "/temp/9-z.jpg" }))).toBe(false);
    expect(another(snapshot({ gameNumber: 1, phase: "answering", round: 3 }), ofGame1({ round: 3, phase: "answering" }))).toBe(false);
    // The game ended while away: its final scores, not another game
    expect(another(snapshot({ started: false, gameNumber: 1, phase: null, round: 0, photo: null }))).toBe(false);
    expect(another(snapshot({ started: false, gameNumber: 2, phase: null, round: 0, photo: null }))).toBe(false);
  });

  it("a screen that knows no game number yet (opened on a game in progress) takes the snapshot's game", () => {
    expect(another(snapshot({ gameNumber: 3, phase: "scores", round: 7 }), view())).toBe(false);
    expect(another(snapshot({ gameNumber: 3, phase: null, round: 0, photo: null }), roundViewOfGame(NO_GAME_NUMBER))).toBe(false);
  });

  // EXP-384: opened from game-started, the screen knows its game before any round event: a rejoin in its ready phase
  // that finds the next game started tells it apart
  it("a screen opened from game-started tells the next game apart already in its ready phase", () => {
    const readyOfGame1 = roundViewOfGame(1);
    expect(readyOfGame1).toEqual({ ...initialRoundView, gameNumber: 1 });
    expect(another(snapshot({ gameNumber: 2, phase: null, round: 0, photo: null }), readyOfGame1)).toBe(true);
    expect(another(snapshot({ gameNumber: 2, phase: "waiting-photo", round: 0, photo: null }), readyOfGame1)).toBe(true);
    expect(another(snapshot({ gameNumber: 1, phase: null, round: 0, photo: null }), readyOfGame1)).toBe(false);
  });
});
