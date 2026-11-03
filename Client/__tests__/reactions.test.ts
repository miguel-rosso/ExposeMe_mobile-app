import {
  appendAllCapped, appendCapped, isAllowedReaction, REACTION_EMOJIS, reactionsOn, roomReactionOf, SCREENSHOT_EMOJI,
  withoutReaction,
} from "../app/utils/reactions";

// EXP-166 / EXP-170: which reactions the client accepts and how lists are capped.
// EXP-393: a burst is appended at once, reactions are kept per photo, and removing one no longer shown keeps the list.

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

describe("appendAllCapped", () => {
  it("appends a burst in order and keeps only the newest past the cap", () => {
    expect(appendAllCapped([1, 2, 3], [4, 5, 6, 7], 5)).toEqual([3, 4, 5, 6, 7]);
    expect(appendAllCapped([1], [2, 3], 5)).toEqual([1, 2, 3]);
  });
});

describe("roomReactionOf", () => {
  const PHOTO = "http://s/temp/1.jpg";
  it("builds a reaction with its own id, on the photo shown, for an allowed emoji from a named player", () => {
    const a = roomReactionOf({ username: "alice", emoji: "😂" }, PHOTO);
    const b = roomReactionOf({ username: "alice", emoji: "😂" }, PHOTO);
    expect(a).toMatchObject({ username: "alice", emoji: "😂", photo: PHOTO });
    expect(a!.id).not.toBe(b!.id);
  });
  it("rejects unknown emojis, a missing name and malformed payloads", () => {
    [{ username: "alice", emoji: "👍" }, { emoji: "😂" }, { username: 7, emoji: "😂" }, null, undefined, "😂"].forEach((d) =>
      expect(roomReactionOf(d, PHOTO)).toBeNull()
    );
  });
  it("rejects every reaction while no photo is shown", () => {
    expect(roomReactionOf({ username: "alice", emoji: "😂" }, null)).toBeNull();
  });
});

describe("reactionsOn", () => {
  const list = [
    { id: "a", username: "alice", emoji: "😂", photo: "p1" }, { id: "b", username: "bob", emoji: "🔥", photo: "p2" },
  ];
  it("keeps only the reactions sent on that photo", () => {
    expect(reactionsOn(list, "p2").map((r) => r.id)).toEqual(["b"]);
    expect(reactionsOn(list, null)).toEqual([]);
  });
  it("returns the same list when they all were", () => {
    const sameList = list.filter((r) => r.photo === "p1");
    expect(reactionsOn(sameList, "p1")).toBe(sameList);
  });
});

describe("withoutReaction", () => {
  const list = [
    { id: "a", username: "alice", emoji: "😂", photo: "p1" }, { id: "b", username: "bob", emoji: "🔥", photo: "p1" },
  ];
  it("removes the reaction with that id", () => {
    expect(withoutReaction(list, "a").map((r) => r.id)).toEqual(["b"]);
  });
  it("returns the same list when the reaction is not there (already pushed out)", () => {
    expect(withoutReaction(list, "gone")).toBe(list);
  });
});
