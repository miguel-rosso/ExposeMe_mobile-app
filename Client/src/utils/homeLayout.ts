// ── Home screen top: language toggle + limited-access banner row, and the logo under it ──

/** Top row (language toggle + limited-access banner): offset from the top and minimum height */
export const HOME_TOP_ROW_TOP = 48;
export const HOME_TOP_ROW_HEIGHT = 40;

/** Logo box, and the emoji drawn over its top-right corner (a square image, resizeMode contain) */
export const LOGO_BOX_HEIGHT = 280;
export const LOGO_EMOJI_TOP = -40;
/** The emoji's box is this fraction of the logo box (both sides, as a percentage style) */
const LOGO_EMOJI_SIZE_PERCENT = 70;
export const LOGO_EMOJI_BOX_PERCENT = `${LOGO_EMOJI_SIZE_PERCENT}%` as const;
export const LOGO_EMOJI_SIZE = (LOGO_BOX_HEIGHT * LOGO_EMOJI_SIZE_PERCENT) / 100;
/** carasonrojada.png has a transparent margin: the face starts 18% below the top of the image */
export const LOGO_EMOJI_FACE_TOP_INSET = 0.18;
/** Space kept between the bottom of the limited-access banner and the top of the face */
export const LOGO_EMOJI_BANNER_CLEARANCE = 8;

/**
 * Scale for the logo emoji, shrunk towards its bottom edge so the face stays clear of the limited-access banner.
 * 1 (the usual layout) while there is no banner or it is already clear. Nothing else moves: the title, the logo box
 * and the emoji's bottom edge stay where they are, so the form below is never pushed down. Both positions are
 * measured (onLayout), so a banner grown by a large system font is accounted for.
 */
export const logoEmojiScale = (logoTop: number | null, bannerBottom: number | null) => {
  if (logoTop === null || bannerBottom === null) return 1;
  const emojiBottom = logoTop + LOGO_EMOJI_TOP + LOGO_EMOJI_SIZE;
  const faceHeight = LOGO_EMOJI_SIZE * (1 - LOGO_EMOJI_FACE_TOP_INSET);
  const roomForFace = emojiBottom - bannerBottom - LOGO_EMOJI_BANNER_CLEARANCE;
  return Math.min(1, Math.max(0, roomForFace / faceHeight));
};

// ── Home screen bottom: Photo Explorer (dice button + label), and the Info link beside the label ──

/** Where the Photo Explorer group sits, from the bottom edge (index.tsx: bottom-15 label, bottom-22 dice button) */
export const PHOTO_EXPLORER_LABEL_BOTTOM = 60;
export const PHOTO_EXPLORER_BUTTON_BOTTOM = 88;
/** The dice button: a 44 pt icon in p-3 padding, centred like its label */
export const PHOTO_EXPLORER_ICON_SIZE = 44;
export const PHOTO_EXPLORER_BUTTON_PADDING = 12;
export const PHOTO_EXPLORER_BUTTON_SIZE = PHOTO_EXPLORER_ICON_SIZE + 2 * PHOTO_EXPLORER_BUTTON_PADDING;

/** Info link (opens the Information screen, EXP-434): right-2 from the edge, py-1, text-xs (16 pt lines) */
export const INFO_LINK_RIGHT = 8;
export const INFO_LINK_PADDING_Y = 4;
export const INFO_LINK_LINE_HEIGHT = 16;
/** Its text wraps to at most this many lines, and follows the system font scale up to this much */
export const INFO_LINK_MAX_LINES = 2;
export const INFO_LINK_MAX_FONT_SCALE = 1.5;
/** On the label's row: its text sits on the label's bottom line */
export const INFO_LINK_BOTTOM = PHOTO_EXPLORER_LABEL_BOTTOM - INFO_LINK_PADDING_Y;
/** Tallest it can get (every line at the largest font scale, plus its padding) */
export const INFO_LINK_MAX_HEIGHT =
  INFO_LINK_MAX_LINES * INFO_LINK_LINE_HEIGHT * INFO_LINK_MAX_FONT_SCALE + 2 * INFO_LINK_PADDING_Y;
/** Extra touch area above and below the short link (none sideways: it would reach towards the label) */
export const INFO_LINK_HIT_SLOP = { top: 12, bottom: 12 } as const;
/** Space kept between the link and the centred label (or dice button, if wider) */
const INFO_LINK_SIDE_GAP = 8;

/**
 * Widest the Info link may be, in the strip right of the centred Photo Explorer label and dice button (EXP-426).
 * `labelWidth` is the label as laid out (it grows with the system font). The link then never reaches the label or the
 * dice, whatever the screen width or font scale, and stays below the dice button's top, so it never comes near the
 * form above it either. The Photo Explorer group itself doesn't move.
 */
export const infoLinkMaxWidth = (screenWidth: number, labelWidth: number) => {
  const centreColumn = Math.max(labelWidth, PHOTO_EXPLORER_BUTTON_SIZE);
  return Math.max(0, (screenWidth - centreColumn) / 2 - INFO_LINK_SIDE_GAP - INFO_LINK_RIGHT);
};
