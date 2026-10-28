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
