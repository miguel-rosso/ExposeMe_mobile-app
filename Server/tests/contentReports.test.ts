import { describe, expect, it } from "vitest";
import { createChatLog } from "../managers/chatLog";
import {
  contentKey, parseReport, REPORT_REASONS, ReportLookups, resolveReport, ShownPhoto,
} from "../managers/contentReports";
import { MAX_USERNAME_LENGTH } from "../managers/playerName";
import { createReportLedger, MAX_PHOTO_COPIES_PER_GAME } from "../managers/reportLedger";
import type { Player, Room } from "../models/interfaces";

// EXP-423: report-content's payload validation, and what a report may point at in the reporter's room. The socket
// handler (session, ack, rate limit, storage) is covered by reportContent.integration.test.ts. Players are told apart by
// their seat (Player object, kept across a rejoin), not their name.

const PHOTO = "/temp/" + "a".repeat(32) + ".jpg";
/** A player's seat in a room: a new object for each player who joins (a rejoin keeps theirs) */
const seat = (username: string) => ({ username }) as Player;

describe("parseReport", () => {
  it("takes a photo report with its round", () => {
    expect(parseReport({ kind: "photo", reason: "sexual", round: 3 })).toEqual({ kind: "photo", reason: "sexual", round: 3 });
  });

  it("takes a message report with its author and text", () => {
    expect(parseReport({ kind: "message", reason: "harassment", author: "bob", text: "hi" }))
      .toEqual({ kind: "message", reason: "harassment", author: "bob", text: "hi" });
  });

  it("takes every reason of the app's picker", () => {
    expect(REPORT_REASONS).toEqual(["sexual", "violence", "harassment", "other"]);
    for (const reason of REPORT_REASONS) expect(parseReport({ kind: "photo", reason, round: 1 })).not.toBeNull();
  });

  it("refuses an unknown kind or reason", () => {
    expect(parseReport({ kind: "player", reason: "other", round: 1 })).toBeNull();
    expect(parseReport({ kind: "photo", reason: "spam", round: 1 })).toBeNull();
    expect(parseReport({ kind: undefined, reason: undefined })).toBeNull();
    expect(parseReport({ kind: ["photo"], reason: "other", round: 1 })).toBeNull();
  });

  it("refuses a photo report whose round is no positive integer", () => {
    for (const round of [0, -1, 1.5, "1", null, undefined, Infinity]) {
      expect(parseReport({ kind: "photo", reason: "other", round })).toBeNull();
    }
  });

  it("refuses a message report without a valid author or text", () => {
    expect(parseReport({ kind: "message", reason: "other", text: "hi" })).toBeNull();
    expect(parseReport({ kind: "message", reason: "other", author: "bob" })).toBeNull();
    expect(parseReport({ kind: "message", reason: "other", author: "", text: "hi" })).toBeNull();
    expect(parseReport({ kind: "message", reason: "other", author: "bob", text: "" })).toBeNull();
    expect(parseReport({ kind: "message", reason: "other", author: "x".repeat(MAX_USERNAME_LENGTH + 1), text: "hi" })).toBeNull();
    expect(parseReport({ kind: "message", reason: "other", author: 7, text: { a: 1 } })).toBeNull();
  });
});

describe("resolveReport", () => {
  const [alice, bob, carol] = ["alice", "bob", "carol"].map(seat);
  const shown: ShownPhoto = { photo: PHOTO, owner: "alice", viewers: new Set([alice, bob]) };
  const lookups: ReportLookups = {
    shownPhoto: (round) => (round === 1 ? shown : undefined),
    heardByReporter: (author, text) => author === "alice" && text === "hello",
  };

  it("a round photo the reporter was shown: its round, owner and photo", () => {
    expect(resolveReport({ kind: "photo", reason: "sexual", round: 1 }, bob, lookups))
      .toEqual({ round: 1, reported: "alice", text: null, photo: PHOTO });
  });

  it("no round photo that round, or one the reporter's seat wasn't shown: nothing", () => {
    expect(resolveReport({ kind: "photo", reason: "sexual", round: 2 }, bob, lookups)).toBeNull();
    expect(resolveReport({ kind: "photo", reason: "sexual", round: 1 }, carol, lookups)).toBeNull();
    // Someone who joined later under the name of a player who was there: another seat
    expect(resolveReport({ kind: "photo", reason: "sexual", round: 1 }, seat("bob"), lookups)).toBeNull();
  });

  it("the reporter's own photo: nothing", () => {
    expect(resolveReport({ kind: "photo", reason: "other", round: 1 }, alice, lookups)).toBeNull();
  });

  it("a message the reporter heard: its author and text", () => {
    expect(resolveReport({ kind: "message", reason: "harassment", author: "alice", text: "hello" }, bob, lookups))
      .toEqual({ round: null, reported: "alice", text: "hello", photo: null });
  });

  it("words never said, or said by someone else: nothing", () => {
    expect(resolveReport({ kind: "message", reason: "harassment", author: "alice", text: "insult" }, bob, lookups)).toBeNull();
    expect(resolveReport({ kind: "message", reason: "harassment", author: "carol", text: "hello" }, bob, lookups)).toBeNull();
  });

  it("the reporter's own message: nothing", () => {
    const own: ReportLookups = { ...lookups, heardByReporter: () => true };
    expect(resolveReport({ kind: "message", reason: "other", author: "bob", text: "hello" }, bob, own)).toBeNull();
  });

  it("contentKey: the same content gives the same key, other content another", () => {
    const photo = { round: 1, reported: "alice", text: null, photo: PHOTO };
    const message = { round: null, reported: "alice", text: "hello", photo: null };
    expect(contentKey(photo)).toBe(contentKey({ ...photo }));
    expect(new Set([contentKey(photo), contentKey({ ...photo, round: 2 }), contentKey(message),
      contentKey({ ...message, text: "hi" }), contentKey({ ...message, reported: "bob" })]).size).toBe(5);
  });
});

describe("createChatLog", () => {
  const room = (...players: Player[]) => ({ gameCode: "ABCDEF", players }) as unknown as Room;

  it("knows the messages sent in each room, by author and exact text, heard by the players there then", () => {
    const [alice, bob] = ["alice", "bob"].map(seat);
    const log = createChatLog();
    const a = room(alice, bob);
    const b = room(alice, bob);
    log.record(a, "alice", "hello");
    expect(log.heardBy(a, "alice", "hello", bob)).toBe(true);
    expect(log.heardBy(a, "alice", "hello ", bob)).toBe(false);
    expect(log.heardBy(a, "bob", "hello", bob)).toBe(false);
    // Another room never shares it
    expect(log.heardBy(b, "alice", "hello", bob)).toBe(false);
  });

  it("a player who joined after a message never heard it, whatever their name", () => {
    const [alice, bob, carol] = ["alice", "bob", "carol"].map(seat);
    const log = createChatLog();
    const a = room(alice, bob);
    log.record(a, "alice", "before carol");
    a.players.push(carol);
    log.record(a, "alice", "after carol");
    expect(log.heardBy(a, "alice", "before carol", carol)).toBe(false);
    expect(log.heardBy(a, "alice", "after carol", carol)).toBe(true);
    expect(log.heardBy(a, "alice", "before carol", seat("bob"))).toBe(false);
  });

  it("keeps only the last `size` messages of a room", () => {
    const [alice, bob] = ["alice", "bob"].map(seat);
    const log = createChatLog(3);
    const a = room(alice, bob);
    ["m1", "m2", "m3", "m4"].forEach((m) => log.record(a, "alice", m));
    expect(log.heardBy(a, "alice", "m1", bob)).toBe(false);
    expect(["m2", "m3", "m4"].every((m) => log.heardBy(a, "alice", m, bob))).toBe(true);
  });
});

describe("createReportLedger", () => {
  const room = (gameNumber: number) => ({ gameCode: "ABCDEF", gameNumber }) as Room;

  it("one report per player and content in a game; another game starts over", () => {
    const [bob, carol] = ["bob", "carol"].map(seat);
    const ledger = createReportLedger();
    const r = room(1);
    expect(ledger.alreadyReported(r, bob, "photo:1")).toBe(false);
    // Asking records nothing: only a stored report counts
    expect(ledger.alreadyReported(r, bob, "photo:1")).toBe(false);
    ledger.recordReport(r, bob, "photo:1");
    expect(ledger.alreadyReported(r, bob, "photo:1")).toBe(true);
    expect(ledger.alreadyReported(r, carol, "photo:1")).toBe(false);
    expect(ledger.alreadyReported(r, bob, "photo:2")).toBe(false);
    r.gameNumber = 2;
    expect(ledger.alreadyReported(r, bob, "photo:1")).toBe(false);
  });

  it(`keeps at most ${MAX_PHOTO_COPIES_PER_GAME} distinct photos per game and room, however many reports each gets`, () => {
    const ledger = createReportLedger();
    const r = room(1);
    const photo = (i: number) => `/temp/${String(i).repeat(32)}.jpg`;
    // Many reports of one photo count it once
    for (let i = 0; i < 3; i++) {
      expect(ledger.mayKeepPhoto(r, photo(0))).toBe(true);
      ledger.photoKept(r, photo(0));
    }
    for (let i = 1; i < MAX_PHOTO_COPIES_PER_GAME; i++) {
      expect(ledger.mayKeepPhoto(r, photo(i))).toBe(true);
      ledger.photoKept(r, photo(i));
    }
    expect(ledger.mayKeepPhoto(r, photo(MAX_PHOTO_COPIES_PER_GAME))).toBe(false);
    // One already kept still is, for its next reports
    expect(ledger.mayKeepPhoto(r, photo(0))).toBe(true);
    // Asking (a photo whose upload turned out gone) spends nothing
    const other = room(1);
    for (let i = 0; i < 10; i++) expect(ledger.mayKeepPhoto(other, photo(i))).toBe(true);
    r.gameNumber = 2;
    expect(ledger.mayKeepPhoto(r, photo(MAX_PHOTO_COPIES_PER_GAME))).toBe(true);
  });
});
