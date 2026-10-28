// The round's progress bar strip at the top of the game photo (see safeAreaRows): the bar plus its p-4 padding, so
// the bar itself clears a cutout by `margin` + 16 dp. The emoji reactions start right below it, and the round
// scoreboard keeps its title and content off the bar.
import type { EdgeInsets } from "react-native-safe-area-context";
import { safeTopRow } from "./safeAreaRows";

export const PROGRESS_BAR_AREA = { top: 60, height: 40, margin: 4 } as const;
/** The strip's p-4 padding above the bar, and the bar's own height (ProgressBar's h-2) */
const BAR_PADDING = 16;
const BAR_HEIGHT = 8;

/** Position of the progress bar strip */
export const progressBarRow = (insets: EdgeInsets) => safeTopRow(insets, PROGRESS_BAR_AREA.top, PROGRESS_BAR_AREA.margin);

/** Distance from the top edge to the bottom of the progress bar strip */
export const progressBarAreaBottom = (insets: EdgeInsets) => progressBarRow(insets).top + PROGRESS_BAR_AREA.height;

/** The visible bar inside the strip: its top and bottom edges, from the top of the screen */
export const progressBarBand = (insets: EdgeInsets) => {
  const top = progressBarRow(insets).top + BAR_PADDING;
  return { top, bottom: top + BAR_HEIGHT };
};
