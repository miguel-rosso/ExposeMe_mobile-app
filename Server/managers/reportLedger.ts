import type { Player, Room } from "../models/interfaces";

// ── Reports already filed in a room's game (EXP-423) ──
// One report per player and content per game: reporting the same photo or message again is acknowledged like the first
// time but not stored twice (the reports file and the webhook only ever get it once). And at most
// MAX_PHOTO_COPIES_PER_GAME distinct photos of a game are kept for review (any number of reports of each): past that,
// reports of other photos are still stored, with no photo, so a room can't fill the disk by reporting every round. Kept in memory per room (WeakMap) and started over
// with each game (room.gameNumber); lobby chat reports count towards the room's last game.

/** Distinct photos one game keeps at most: more than a game's rounds would ever need to show abuse. */
export const MAX_PHOTO_COPIES_PER_GAME = 5;

interface GameLedger {
  gameNumber: number;
  /** Content keys (contentReports.contentKey) each player already reported */
  reported: Map<Player, Set<string>>;
  /** The photos of this game kept so far, by upload path */
  photosKept: Set<string>;
}

export function createReportLedger(maxPhotoCopies = MAX_PHOTO_COPIES_PER_GAME) {
  const ledgers = new WeakMap<Room, GameLedger>();
  /** The ledger of the room's current (or last) game, a fresh one once another game started */
  const ledgerOf = (room: Room): GameLedger => {
    const current = ledgers.get(room);
    if (current?.gameNumber === room.gameNumber) return current;
    const fresh: GameLedger = { gameNumber: room.gameNumber, reported: new Map(), photosKept: new Set() };
    ledgers.set(room, fresh);
    return fresh;
  };
  return {
    /** `reporter` already reported `key` in this game. */
    alreadyReported(room: Room, reporter: Player, key: string): boolean {
      return ledgerOf(room).reported.get(reporter)?.has(key) ?? false;
    },
    /** `reporter`'s report of `key` is stored (queued): later ones of it in this game are not stored again. */
    recordReport(room: Room, reporter: Player, key: string): void {
      const { reported } = ledgerOf(room);
      reported.set(reporter, (reported.get(reporter) ?? new Set<string>()).add(key));
    },
    /** `photo` may be kept for this game: kept already, or the game has room for one more. */
    mayKeepPhoto(room: Room, photo: string): boolean {
      const { photosKept } = ledgerOf(room);
      return photosKept.has(photo) || photosKept.size < maxPhotoCopies;
    },
    /** `photo` was kept for this game (counted once, however many reports it gets). */
    photoKept(room: Room, photo: string): void {
      ledgerOf(room).photosKept.add(photo);
    },
  };
}

export type ReportLedger = ReturnType<typeof createReportLedger>;
