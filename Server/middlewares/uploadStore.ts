import fs from "fs";

// ── Per-room upload registry ──
// Every stored photo belongs to the room and player that uploaded it (GET /temp serves it only to members of that
// room; photo-sent / plant-photo only take the sender's own uploads). A room's photos are deleted as soon as its game
// ends or the room is emptied/deleted, and a player's when they leave or are removed; the 30-min TTL
// (middlewares/uploadSweeper) stays as a backstop for anything missed (e.g. a restart).

export interface UploadRecord {
  gameCode: string;
  username: string;
  /** Absolute path of the stored file */
  file: string;
  /** Exact TTL deletion timer (UploadController); cleared when the record goes away earlier */
  timer?: NodeJS.Timeout;
}

export class UploadStore {
  private byName = new Map<string, UploadRecord>();
  private byRoom = new Map<string, Set<string>>();
  /** Bumped on every release, so uploads authorized before it are refused when they finish processing. */
  private epochs = new Map<string, number>();

  epoch(gameCode: string): number {
    return this.epochs.get(gameCode) ?? 0;
  }

  /** Records an upload authorized at `epoch`. Returns false (nothing recorded) if the room was released since. */
  register(name: string, record: UploadRecord, epoch: number): boolean {
    if (epoch !== this.epoch(record.gameCode)) return false;
    this.byName.set(name, record);
    let names = this.byRoom.get(record.gameCode);
    if (!names) this.byRoom.set(record.gameCode, (names = new Set()));
    names.add(name);
    return true;
  }

  get(name: string): UploadRecord | undefined {
    return this.byName.get(name);
  }

  countFor(gameCode: string): number {
    return this.byRoom.get(gameCode)?.size ?? 0;
  }

  /** Forgets one upload without deleting its file (it was deleted elsewhere, e.g. TTL expiry). */
  forget(name: string): UploadRecord | undefined {
    const record = this.byName.get(name);
    if (!record) return undefined;
    if (record.timer) clearTimeout(record.timer);
    this.byName.delete(name);
    const names = this.byRoom.get(record.gameCode);
    names?.delete(name);
    if (names && !names.size) this.byRoom.delete(record.gameCode);
    return record;
  }

  /** Forgets one upload and deletes its file. */
  private remove(name: string): void {
    const record = this.forget(name);
    if (!record) return;
    fs.unlink(record.file, (err) => {
      if (err && err.code !== "ENOENT") console.error("Error deleting room upload:", err.code);
    });
  }

  /** Game over / room emptied: deletes all of the room's photos and refuses uploads authorized before now. */
  releaseRoom(gameCode: string): void {
    this.epochs.set(gameCode, this.epoch(gameCode) + 1);
    for (const name of [...(this.byRoom.get(gameCode) ?? [])]) this.remove(name);
  }

  /**
   * A player left or was removed: deletes their photos in the room, except `keep` (the photo on screen right now,
   * released with the rest of the room's photos at game over).
   */
  releasePlayer(gameCode: string, username: string, keep?: string | null): void {
    for (const name of [...(this.byRoom.get(gameCode) ?? [])]) {
      if (name !== keep && this.byName.get(name)?.username === username) this.remove(name);
    }
  }

  /**
   * Room deleted: release its photos and forget the room. (An upload authorized before the deletion is still
   * refused when it finishes: /upload re-checks that the same room object exists, see uploadAccess.)
   */
  dropRoom(gameCode: string): void {
    this.releaseRoom(gameCode);
    this.epochs.delete(gameCode);
  }

  /** Forget everything without touching files (tests). */
  clear(): void {
    for (const record of this.byName.values()) if (record.timer) clearTimeout(record.timer);
    this.byName.clear();
    this.byRoom.clear();
    this.epochs.clear();
  }
}

/** Process-wide registry used by /upload, /temp, GameEngine (game over) and RoomManager (room closed). */
export const uploadStore = new UploadStore();
