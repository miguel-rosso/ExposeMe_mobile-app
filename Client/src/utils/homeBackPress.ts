// ── Android hardware back on the home screen ──

import { dismissKeyboardOnBackPress, KeyboardControl } from "./keyboardBackPress";

export type HomeBackPressDeps = {
  keyboard: KeyboardControl;
  isJoiningGame: boolean;
  cancelJoin: () => void;
};

/** Returns true when the press is consumed; false lets Android run the default (leave the app). */
export const handleHomeBackPress = ({ keyboard, isJoiningGame, cancelJoin }: HomeBackPressDeps): boolean => {
  if (dismissKeyboardOnBackPress(keyboard)) return true;
  if (isJoiningGame) {
    cancelJoin();
    return true;
  }
  return false;
};
