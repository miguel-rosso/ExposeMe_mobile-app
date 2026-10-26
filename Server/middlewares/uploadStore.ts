import fs from "fs";
import { UPLOAD_TTL_MS } from "./uploadSweeper";

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
  /**
   * Epoch ms after which the photo is expired, stamped by register (UPLOAD_TTL_MS from then). The file is written
   * after registering, so this is never later than the deadline /temp and the sweeper derive from its mtime.
   */
  expiresAt?: number;
  /** room.round when it was stored: a photo shown since then was stored at an earlier round (rounds only advance on show) */
  round?: number;
  /** Authorized as the awaited owner's turn photo, or as a (candidate) planted photo; see releaseSuperseded */
  kind?: "turn" | "planted";
  /** Planted with plant-photo (pending or already shown): only a later plant-photo of the same player releases it */
  planted?: boolean;
}

/** Store name of a `/temp/<name>` path (or the name itself). */
const nameOf = (pathOrName: string) => (pathOrName.startsWith("/temp/") ? pathOrName.slice("/temp/".length) : pathOrName);

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
    record.expiresAt = Date.now() + UPLOAD_TTL_MS;
    this.byName.set(name, record);
    let names = this.byRoom.get(record.gameCode);
    if (!names) this.byRoom.set(record.gameCode, (names = new Set()));
    names.add(name);
    return true;
  }

  get(name: string): UploadRecord | undefined {
    return this.byName.get(name);
  }

  /**
   * The photo at `pathOrName` is still stored and will not expire within `minRemainingMs` (a photo whose record is
   * gone was deleted: TTL expiry, released with its room or player).
   */
  isLive(pathOrName: string, minRemainingMs = 0): boolean {
    const record = this.byName.get(nameOf(pathOrName));
    return !!record && (record.expiresAt ?? Infinity) - Date.now() > minRemainingMs;
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

  /** Forgets one upload and deletes its file (no-op if it is not stored). */
  remove(pathOrName: string): void {
    const record = this.forget(nameOf(pathOrName));
    if (!record) return;
    fs.unlink(record.file, (err) => {
      if (err && err.code !== "ENOENT") console.error("Error deleting room upload:", err.code);
    });
  }

  /**
   * A new upload `name` of this player was stored: releases their earlier uploads of the same round and kind (a turn
   * upload never drops a lobby pick and vice versa) that were neither planted nor shown (`keep`: the photo on
   * screen), except the newest of them. That one may still be about
   * to be used: the app can run two uploads at once (planted-photo retry + its round-1 photo) and sends plant-photo /
   * photo-sent only after each answers. Each player thus holds at most two unused uploads per round and kind, so
   * re-picking a photo (lobby or own turn) can't pile files up towards the room cap.
   */
  releaseSuperseded(name: string, keep?: string | null): void {
    const record = this.byName.get(name);
    if (!record) return;
    const keepName = keep ? nameOf(keep) : null;
    // byRoom keeps registration order: the last candidate is the newest
    const unused = [...(this.byRoom.get(record.gameCode) ?? [])].filter((other) => {
      const r = this.byName.get(other);
      if (other === name || other === keepName || !r || r.planted) return false;
      return r.username === record.username && r.round === record.round && r.kind === record.kind;
    });
    for (const other of unused.slice(0, -1)) this.remove(other);
  }

  /**
   * plant-photo: marks `next` as this player's planted photo and releases the one it replaces (`previous`, their
   * current plantedPhoto; never one already shown, which the engine clears from the player when it is drawn).
   */
  replacePlanted(previous: string | undefined, next: string): void {
    const record = this.byName.get(nameOf(next));
    if (!record) return;
    record.planted = true;
    if (!previous || nameOf(previous) === nameOf(next)) return;
    const old = this.byName.get(nameOf(previous));
    if (old?.gameCode === record.gameCode && old.username === record.username) this.remove(nameOf(previous));
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
