// ── Android hardware back on the home screen ──

export type HomeBackPressDeps = {
  keyboard: { isVisible: () => boolean; dismiss: () => void };
  isJoiningGame: boolean;
  cancelJoin: () => void;
};

/** Returns true when the press is consumed; false lets Android run the default (leave the app). */
export const handleHomeBackPress = ({ keyboard, isJoiningGame, cancelJoin }: HomeBackPressDeps): boolean => {
  // Android (RN 0.88) still delivers the back press to the app after the IME used it to close the keyboard
  if (keyboard.isVisible()) {
    keyboard.dismiss();
    return true;
  }
  if (isJoiningGame) {
    cancelJoin();
    return true;
  }
  return false;
};
