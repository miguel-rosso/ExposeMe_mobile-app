import {
  HOME_TOP_ROW_TOP,
  LOGO_EMOJI_BANNER_CLEARANCE,
  LOGO_EMOJI_FACE_TOP_INSET,
  LOGO_EMOJI_SIZE,
  LOGO_EMOJI_TOP,
  logoEmojiScale,
} from "../src/utils/homeLayout";

// EXP-281: with limited access the banner pill touched the logo emoji. The emoji now shrinks towards its bottom edge
// just enough to clear the measured banner; nothing else in the logo moves.

/** The logo sits at top-[10%] of the window */
const logoTopFor = (windowHeight: number) => windowHeight * 0.1;
/** Top of the emoji's face once scaled towards its bottom edge */
const faceTop = (logoTop: number, scale: number) =>
  logoTop + LOGO_EMOJI_TOP + LOGO_EMOJI_SIZE - scale * LOGO_EMOJI_SIZE * (1 - LOGO_EMOJI_FACE_TOP_INSET);

/** Banner pill bottom: ~30 pt pill centred in the 40 pt row; with a 2x system font the pill (and the row) is ~60 pt */
const PILL_BOTTOM = HOME_TOP_ROW_TOP + 5 + 30;
const LARGE_FONT_PILL_BOTTOM = HOME_TOP_ROW_TOP + 60;

describe("logoEmojiScale (EXP-281)", () => {
  it("no banner, or not laid out yet: the usual emoji", () => {
    expect(logoEmojiScale(logoTopFor(640), null)).toBe(1);
    expect(logoEmojiScale(null, PILL_BOTTOM)).toBe(1);
  });

  it("a banner already clear of the face leaves the emoji as it is", () => {
    expect(logoEmojiScale(200, PILL_BOTTOM)).toBe(1);
  });

  it.each([
    ["360x592", 592, PILL_BOTTOM],
    ["360x640", 640, PILL_BOTTOM],
    ["iPhone 14 (844)", 844, PILL_BOTTOM],
    ["360x640, 2x system font", 640, LARGE_FONT_PILL_BOTTOM],
    ["iPhone 14, 2x system font", 844, LARGE_FONT_PILL_BOTTOM],
  ])("%s: the face ends up just below the banner", (_, height, bannerBottom) => {
    const logoTop = logoTopFor(height);
    const scale = logoEmojiScale(logoTop, bannerBottom);
    expect(faceTop(logoTop, 1)).toBeLessThan(bannerBottom + LOGO_EMOJI_BANNER_CLEARANCE); // it did touch it
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(0);
    expect(faceTop(logoTop, scale)).toBeCloseTo(bannerBottom + LOGO_EMOJI_BANNER_CLEARANCE);
  });
});
