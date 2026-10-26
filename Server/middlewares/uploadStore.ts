import fs from "fs";
import { envInt } from "./rateLimit";
import { UPLOAD_TTL_MS } from "./uploadSweeper";

// ── Server-wide storage limits ──
// The per-room cap (MAX_UPLOADS_PER_ROOM) doesn't bound the disk when many rooms fill up, so lobby photos (anything
// but the awaited owner's turn photo: lobby picks and planted photos, which wait minutes for their round) are shed
// first: none is stored while the server holds UPLOAD_STORED_MAX photos, nor past UPLOAD_LOBBY_PER_IP_MAX of them
// per uploader IP (IPv6 per /48, which one subscriber often holds whole), so one IP can't fill the server-wide budget
// from rooms of its own. A turn photo of a started game is never refused here: it only comes from the awaited owner,
// one per round at game pace, and the per-room cap still bounds it. Sanitized photos are ≤ 2048 px (~1 MB), so the default keeps lobby photos within a few GB.

export const UPLOAD_STORED_MAX = envInt("UPLOAD_STORED_MAX", 3_000, 1, 10_000_000);
/**
 * Each player holds ~3 lobby photos (planted + re-picks), so a full party (12 players) needs ~36; the default fits
 * several full parties on one venue Wi-Fi (one public IP) with room to spare.
 */
export const UPLOAD_LOBBY_PER_IP_MAX = envInt("UPLOAD_LOBBY_PER_IP_MAX", 150, 1, 10_000_000);

/**
 * A planted-kind upload is only useful once plant-photo claims it, which the app sends as soon as the upload answers.
 * One left unclaimed this long is deleted instead of waiting for the TTL (e.g. a turn upload retried after background
 * that only arrives once the game is over, back in the lobby). Generous for a slow network; a client that misses it
 * re-plants when its rejoin reports no planted photo.
 */
export const UPLOAD_PLANT_CLAIM_MS = envInt("UPLOAD_PLANT_CLAIM_MS", 2 * 60_000, 100, UPLOAD_TTL_MS);

/** Why a new upload can't be stored now: 503 server-wide, 429 for the uploader's IP; retry once a photo expires. */
export interface StorageRefusal {
  status: 429 | 503;
  scope: "storage" | "lobby-ip";
  /** Seconds until the oldest photo that counts against the exceeded limit expires (it may be released sooner). */
  retryAfterS: number;
}

// ── Per-room upload registry ──
// Every stored photo belongs to the room and player that uploaded it (GET /temp serves it only to members of that
// room; photo-sent / plant-photo only take the sender's own uploads). A room's photos are deleted as soon as its game
// ends or the room is emptied/deleted, a player's when they leave or are removed, and a planted-kind upload when
// plant-photo doesn't claim it in time (UPLOAD_PLANT_CLAIM_MS); the 30-min TTL
// (middlewares/uploadSweeper) stays as a backstop for anything missed (e.g. a restart).

export interface UploadRecord {
  gameCode: string;
  username: string;
  /** Absolute path of the stored file */
  file: string;
  /** Exact TTL deletion timer (UploadController); cleared when the record goes away earlier */
  timer?: NodeJS.Timeout;
  /** Planted-kind upload not yet claimed by plant-photo: deletes it after UPLOAD_PLANT_CLAIM_MS (see awaitClaim) */
  claimTimer?: NodeJS.Timeout;
  /** Epoch ms when claimTimer deletes it; unset once claimed (or never set: turn uploads) */
  claimDeadline?: number;
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
  /** Uploader's lobby-limit key (clientIp, IPv6 widened to its /48): lobby photos count against UPLOAD_LOBBY_PER_IP_MAX */
  ip?: string;
}

/** Storage limits (see above) and the unclaimed planted-upload window; the defaults come from the environment. */
interface StoreLimits {
  storedMax: number;
  lobbyPerIpMax: number;
  plantClaimMs: number;
}

const DEFAULT_LIMITS: StoreLimits = {
  storedMax: UPLOAD_STORED_MAX,
  lobbyPerIpMax: UPLOAD_LOBBY_PER_IP_MAX,
  plantClaimMs: UPLOAD_PLANT_CLAIM_MS,
};

/** Stops a record's pending deletions (it is going away or being forgotten). */
function clearTimers(record: UploadRecord): void {
  if (record.timer) clearTimeout(record.timer);
  if (record.claimTimer) clearTimeout(record.claimTimer);
}

/** plant-photo claimed it: kept until the TTL (or until its room / player is released). */
function markClaimed(record: UploadRecord): void {
  if (record.claimTimer) clearTimeout(record.claimTimer);
  delete record.claimTimer;
  delete record.claimDeadline;
}

/** Epoch ms when the record is deleted at the latest: TTL expiry, or its claim deadline while unclaimed. */
const deletionDeadline = (record: UploadRecord, now: number) =>
  Math.min(record.expiresAt ?? now, record.claimDeadline ?? Infinity);

/** Counts against the lobby-photo limits: anything but the awaited owner's turn photo. */
const isLobbyPhoto = (record: Pick<UploadRecord, "kind">) => record.kind !== "turn";

/** Store name of a `/temp/<name>` path (or the name itself). */
const nameOf = (pathOrName: string) => (pathOrName.startsWith("/temp/") ? pathOrName.slice("/temp/".length) : pathOrName);

export class UploadStore {
  /**
   * Registration order, which is also TTL order (every record expires UPLOAD_TTL_MS after registering); unclaimed
   * planted uploads may go sooner (claimDeadline).
   */
  private byName = new Map<string, UploadRecord>();
  private byRoom = new Map<string, Set<string>>();
  /** Bumped on every release, so uploads authorized before it are refused when they finish processing. */
  private epochs = new Map<string, number>();
  /** Stored lobby photos per uploader IP key (keys dropped at zero). */
  private lobbyPerIp = new Map<string, number>();

  private readonly limits: StoreLimits;

  constructor(limits: Partial<StoreLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

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
    this.countLobbyPhoto(record, +1);
    if (record.kind === "planted") this.awaitClaim(name, record);
    return true;
  }

  /** Deletes a planted-kind upload unless plant-photo claims it (replacePlanted) within the claim window. */
  private awaitClaim(name: string, record: UploadRecord): void {
    record.claimDeadline = Date.now() + this.limits.plantClaimMs;
    record.claimTimer = setTimeout(() => this.remove(name), this.limits.plantClaimMs);
    record.claimTimer.unref();
  }

  /**
   * Null if a new upload of `kind` from IP key `ip` may be stored now, else why not (see the storage limits above).
   * A turn photo is never refused.
   */
  storageRefusal(kind: UploadRecord["kind"], ip: string): StorageRefusal | null {
    if (!isLobbyPhoto({ kind })) return null;
    if (this.byName.size >= this.limits.storedMax) {
      return { status: 503, scope: "storage", retryAfterS: this.secondsToFirstExpiry(() => true) };
    }
    if ((this.lobbyPerIp.get(ip) ?? 0) >= this.limits.lobbyPerIpMax) {
      const ownLobbyPhoto = (r: UploadRecord) => r.ip === ip && isLobbyPhoto(r);
      return { status: 429, scope: "lobby-ip", retryAfterS: this.secondsToFirstExpiry(ownLobbyPhoto) };
    }
    return null;
  }

  /** Whole seconds (≥ 1) until the first matching photo goes: TTL expiry, or the claim deadline if unclaimed. */
  private secondsToFirstExpiry(matches: (record: UploadRecord) => boolean): number {
    const now = Date.now();
    let first = Infinity;
    for (const record of this.byName.values()) {
      if (matches(record)) first = Math.min(first, deletionDeadline(record, now));
    }
    return first === Infinity ? 1 : Math.max(1, Math.ceil((first - now) / 1000));
  }

  private countLobbyPhoto(record: UploadRecord, delta: 1 | -1): void {
    if (!record.ip || !isLobbyPhoto(record)) return;
    const count = (this.lobbyPerIp.get(record.ip) ?? 0) + delta;
    if (count > 0) this.lobbyPerIp.set(record.ip, count);
    else this.lobbyPerIp.delete(record.ip);
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

  /** Photos stored right now, all rooms together. */
  get size(): number {
    return this.byName.size;
  }

  /** Forgets one upload without deleting its file (it was deleted elsewhere, e.g. TTL expiry). */
  forget(name: string): UploadRecord | undefined {
    const record = this.byName.get(name);
    if (!record) return undefined;
    clearTimers(record);
    this.byName.delete(name);
    const names = this.byRoom.get(record.gameCode);
    names?.delete(name);
    if (names && !names.size) this.byRoom.delete(record.gameCode);
    this.countLobbyPhoto(record, -1);
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
    markClaimed(record);
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
    for (const record of this.byName.values()) clearTimers(record);
    this.byName.clear();
    this.byRoom.clear();
    this.epochs.clear();
    this.lobbyPerIp.clear();
  }
}

/** Process-wide registry used by /upload, /temp, GameEngine (game over) and RoomManager (room closed). */
export const uploadStore = new UploadStore();
