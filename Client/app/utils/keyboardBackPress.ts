// ── Android hardware back with the keyboard open ──

export type KeyboardControl = { isVisible: () => boolean; dismiss: () => void };

/**
 * Android (RN 0.88) still delivers the back press to the app after the IME used it to close the keyboard, so a
 * screen with a text input would also run its own back action. Returns true (press consumed) when the keyboard
 * was open and has been dismissed.
 */
export const dismissKeyboardOnBackPress = (keyboard: KeyboardControl): boolean => {
  if (!keyboard.isVisible()) return false;
  keyboard.dismiss();
  return true;
};
