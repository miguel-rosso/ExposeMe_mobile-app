import type { TextStyle } from "react-native";

// ── Brand tokens (the look of the home screen, app/index.tsx) ──

/** The brand's bright red */
export const BRAND_RED = "#e9042e";
const BRAND_RED_DARK = "#9d0420";

/** Primary buttons: dark red at the edges, bright red in the middle (horizontal LinearGradient) */
export const BRAND_GRADIENT = [BRAND_RED_DARK, BRAND_RED, BRAND_RED_DARK] as const;

/** The game's mascot */
export const BRAND_MASCOT_EMOJI = "😳";

/** Display font loaded in app/_layout.tsx (assets/fonts/b.otf) */
export const BRAND_DISPLAY_FONT = "IconFont";

// The home logo (96 px) casts a 10/5 px shadow with a 3 px blur: the factory keeps those proportions
const LOGO_REFERENCE_FONT_SIZE = 96;
const LOGO_SHADOW_OFFSET_X = 10;
const LOGO_SHADOW_RADIUS = 3;
/** Below this the blur disappears and the shadow looks like a hard copy of the text */
const MIN_SHADOW_RADIUS = 2;
const LOGO_SHADOW_COLOR = "rgba(0, 0, 0, 0.5)";

/** Drop shadow of the display titles, scaled to the font size (exactly the home logo's at 96 px) */
export const brandTitleShadow = (fontSize: number): TextStyle => {
  const scale = fontSize / LOGO_REFERENCE_FONT_SIZE;
  const offsetX = Math.round(LOGO_SHADOW_OFFSET_X * scale);
  return {
    textShadowColor: LOGO_SHADOW_COLOR,
    textShadowOffset: { width: offsetX, height: Math.round(offsetX / 2) },
    textShadowRadius: Math.max(MIN_SHADOW_RADIUS, Math.round(LOGO_SHADOW_RADIUS * scale)),
  };
};
