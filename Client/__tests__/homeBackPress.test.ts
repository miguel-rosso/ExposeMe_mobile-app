import { handleHomeBackPress } from "../src/utils/homeBackPress";

const setup = (keyboardVisible: boolean, isJoiningGame: boolean) => {
  const keyboard = { isVisible: jest.fn(() => keyboardVisible), dismiss: jest.fn() };
  const cancelJoin = jest.fn();
  const consumed = handleHomeBackPress({ keyboard, isJoiningGame, cancelJoin });
  return { consumed, keyboard, cancelJoin };
};

describe("home hardware back (EXP-058)", () => {
  it("only closes the keyboard when it is open, even while joining", () => {
    for (const joining of [false, true]) {
      const { consumed, keyboard, cancelJoin } = setup(true, joining);
      expect(consumed).toBe(true);
      expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
      expect(cancelJoin).not.toHaveBeenCalled();
    }
  });

  it("cancels the join flow when the keyboard is hidden", () => {
    const { consumed, keyboard, cancelJoin } = setup(false, true);
    expect(consumed).toBe(true);
    expect(cancelJoin).toHaveBeenCalledTimes(1);
    expect(keyboard.dismiss).not.toHaveBeenCalled();
  });

  it("lets Android leave the app otherwise", () => {
    const { consumed, keyboard, cancelJoin } = setup(false, false);
    expect(consumed).toBe(false);
    expect(cancelJoin).not.toHaveBeenCalled();
    expect(keyboard.dismiss).not.toHaveBeenCalled();
  });
});
