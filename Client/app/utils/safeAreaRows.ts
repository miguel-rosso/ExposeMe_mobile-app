// Full-width rows laid over the game photo (timer bar, answers, emoji row, hold button…) are placed at a fixed
// distance from a screen edge, kept clear of the notch, the Dynamic Island, a camera cutout, the home indicator and
// the navigation bar. On a device without any of them every inset is 0 and the rows stay exactly where the fixed
// offsets put them.
import type { EdgeInsets } from "react-native-safe-area-context";

/**
 * Distance from the physical top edge for something designed `top` dp below it. The top offsets were already
 * picked to clear a status bar, so they are kept as long as they clear the top inset; only a taller cutout pushes
 * the row down, to `margin` dp below it.
 */
export const topClearOfInset = (insets: EdgeInsets, top: number, margin: number) =>
  Math.max(top, insets.top + margin);

/** Position of an absolute full-width row `top` dp below the top edge, at least `margin` dp below the top inset */
export const safeTopRow = (insets: EdgeInsets, top: number, margin: number) => ({
  top: topClearOfInset(insets, top, margin), left: insets.left, right: insets.right,
});

/** Position of an absolute full-width row `bottom` dp above the safe area's bottom edge */
export const safeBottomRow = (insets: EdgeInsets, bottom: number) => ({
  bottom: insets.bottom + bottom, left: insets.left, right: insets.right,
});
