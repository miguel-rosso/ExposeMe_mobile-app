import { applyRoundStart, RoundStartSetters } from "../app/utils/roundStart";

const makeSetters = () => {
  const s = {
    setPhoto: jest.fn(),
    setPhotoOwner: jest.fn(),
    setRound: jest.fn(),
    setPhase: jest.fn(),
    setPhaseDuration: jest.fn(),
    setPhaseKey: jest.fn(),
    setCorrectAnswer: jest.fn(),
    setScores: jest.fn(),
    setMySelection: jest.fn(),
    setGameHeld: jest.fn(),
    setPressing: jest.fn(),
  };
  return s as typeof s & RoundStartSetters;
};

describe("applyRoundStart (EXP-001)", () => {
  const data = { photo: "/temp/a.jpg", owner: "alice", round: 3, duration: 10000 };

  it("does not throw and clears hold state left over from the previous round", () => {
    const s = makeSetters();
    expect(() => applyRoundStart(data, "http://srv", s)).not.toThrow();
    expect(s.setGameHeld).toHaveBeenCalledWith(false);
    expect(s.setPressing).toHaveBeenCalledWith(false);
  });

  it("sets the new round photo/owner/phase and resets per-round answer state", () => {
    const s = makeSetters();
    applyRoundStart(data, "http://srv", s);
    expect(s.setPhoto).toHaveBeenCalledWith("http://srv/temp/a.jpg");
    expect(s.setPhotoOwner).toHaveBeenCalledWith("alice");
    expect(s.setRound).toHaveBeenCalledWith(3);
    expect(s.setPhase).toHaveBeenCalledWith("answering");
    expect(s.setPhaseDuration).toHaveBeenCalledWith(10000);
    expect(s.setCorrectAnswer).toHaveBeenCalledWith("");
    expect(s.setScores).toHaveBeenCalledWith(null);
    expect(s.setMySelection).toHaveBeenCalledWith("");
    const bump = s.setPhaseKey.mock.calls[0][0] as (k: number) => number;
    expect(bump(4)).toBe(5);
  });
});
