import { appendCapped, isAllowedReaction, REACTION_EMOJIS, SCREENSHOT_EMOJI } from "../app/utils/reactions";

// EXP-166 / EXP-170: which reactions the client accepts and how lists are capped.

describe("isAllowedReaction", () => {
  it("accepts the picker's emojis and the screenshot emoji", () => {
    REACTION_EMOJIS.forEach((e) => expect(isAllowedReaction(e)).toBe(true));
    expect(isAllowedReaction(SCREENSHOT_EMOJI)).toBe(true);
  });
  it("rejects anything else", () => {
    ["👍", "📸 Took a Screenshot", "Screenshot", "", "😂😂", 1, null, undefined, {}].forEach((e) =>
      expect(isAllowedReaction(e)).toBe(false)
    );
  });
});

describe("appendCapped", () => {
  it("drops the oldest items past the cap", () => {
    let list: number[] = [];
    for (let i = 0; i < 100; i++) list = appendCapped(list, i, 5);
    expect(list).toEqual([95, 96, 97, 98, 99]);
  });
  it("keeps everything under the cap", () => {
    expect(appendCapped([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });
});
