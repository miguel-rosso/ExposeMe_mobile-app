import {
  HOME_TOP_ROW_TOP,
  LOGO_EMOJI_BANNER_CLEARANCE,
  LOGO_EMOJI_FACE_TOP_INSET,
  LOGO_EMOJI_SIZE,
  LOGO_EMOJI_TOP,
  logoEmojiScale,
  PHOTO_EXPLORER_BUTTON_BOTTOM,
  PHOTO_EXPLORER_BUTTON_SIZE,
  PHOTO_EXPLORER_LABEL_BOTTOM,
  PRIVACY_LINK_BOTTOM,
  PRIVACY_LINK_HIT_SLOP,
  PRIVACY_LINK_MAX_HEIGHT,
  PRIVACY_LINK_RIGHT,
  privacyLinkMaxWidth,
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

// EXP-426: the privacy link shares the Photo Explorer label's row, in the strip right of the centred label and dice
// button, and is never taller than what fits below the dice button's top; the Photo Explorer group doesn't move.

/** Generous width of the 14-character bold label ("Photo Explorer" / "Explorar Fotos", 14 pt: ~0.6 em a glyph) */
const labelWidthAt = (fontScale: number) => 14 * 0.6 * 14 * fontScale;

/** The phones the reviewer measured: 360 pt Android with 3-button navigation, 375 pt iPhone with a home indicator */
const PHONES = [
  { name: "360 pt, 48 pt inset, font 1.3", width: 360, bottomInset: 48, fontScale: 1.3 },
  { name: "360 pt, 48 pt inset, font 1", width: 360, bottomInset: 48, fontScale: 1 },
  { name: "375 pt, 34 pt inset, font 1", width: 375, bottomInset: 34, fontScale: 1 },
  { name: "375 pt, 34 pt inset, font 1.3", width: 375, bottomInset: 34, fontScale: 1.3 },
];

describe("privacy link beside Photo Explorer (EXP-426)", () => {
  it("the Photo Explorer group stays where it was (label bottom-15, dice bottom-22)", () => {
    expect(PHOTO_EXPLORER_LABEL_BOTTOM).toBe(60);
    expect(PHOTO_EXPLORER_BUTTON_BOTTOM).toBe(88);
  });

  it.each(PHONES)("$name: the link never reaches the label or the dice", ({ width, fontScale }) => {
    const labelWidth = labelWidthAt(fontScale);
    const linkRight = width - PRIVACY_LINK_RIGHT;
    const linkLeft = linkRight - privacyLinkMaxWidth(width, labelWidth);
    const centreColumnRight = width / 2 + Math.max(labelWidth, PHOTO_EXPLORER_BUTTON_SIZE) / 2;

    expect(privacyLinkMaxWidth(width, labelWidth)).toBeGreaterThan(0);
    expect(linkLeft).toBeGreaterThan(centreColumnRight);
  });

  it.each(PHONES)("$name: the link clears the bottom inset and stays below the dice button's top", ({ bottomInset }) => {
    expect(PRIVACY_LINK_BOTTOM).toBeGreaterThan(bottomInset);
    expect(PRIVACY_LINK_BOTTOM + PRIVACY_LINK_MAX_HEIGHT + PRIVACY_LINK_HIT_SLOP.top).toBeLessThanOrEqual(
      PHOTO_EXPLORER_BUTTON_BOTTOM + PHOTO_EXPLORER_BUTTON_SIZE
    );
  });

  it("holds for any label width, even one wider than the screen", () => {
    for (const width of [320, 360, 375, 414]) {
      for (const labelWidth of [0, 40, 120, 200, width, width + 100]) {
        const maxWidth = privacyLinkMaxWidth(width, labelWidth);
        expect(maxWidth).toBeGreaterThanOrEqual(0);
        if (maxWidth > 0) {
          expect(width - PRIVACY_LINK_RIGHT - maxWidth).toBeGreaterThan(width / 2 + Math.max(labelWidth, PHOTO_EXPLORER_BUTTON_SIZE) / 2);
        }
      }
    }
  });
});
