import { randomBytes, timingSafeEqual } from "crypto";
import { Player, PublicPlayer, Room, SafeRoom } from "../models/interfaces";
import { uploadNameOf, uploadStore } from "../middlewares/uploadStore";
import { nameClash, NameKeys, nameKeys } from "./playerName";
import { randomRoomCode } from "./roomCode";

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;
/** Cleanup delay for rooms that never had a second player (created and abandoned). */
const SOLO_ROOM_CLEANUP_DELAY = 2 * 60 * 1000;
export const MAX_PLAYERS_PER_ROOM = 12;
/** Global cap on rooms held in memory; creating beyond it is refused with "Server is busy". */
export const MAX_ROOMS = 5000;
/**
 * A player disconnected for longer than this is "gone": the lobby shows them as disconnected, a gone host hands the
 * role over, and a game start removes them. Shorter absences (app switch, brief signal loss) go unnoticed (DEC-009).
 */
export const DISCONNECT_GRACE = 15_000;
/** Round counts the host can pick in the app. */
export const ROUND_OPTIONS = [10, 15, 20];
/** QA-only short game (EXP-100): accepted only when the server runs with ALLOW_QA_ROUNDS=1; never offered in the app. */
export const QA_ROUNDS = 3;

/** Whether `rounds` is a valid set-rounds value. The env is read per call, so the QA flag is off unless set. */
export function isAllowedRounds(rounds: unknown, env: NodeJS.ProcessEnv = process.env): rounds is number {
  if (typeof rounds !== "number") return false;
  if (ROUND_OPTIONS.includes(rounds)) return true;
  return rounds === QA_ROUNDS && env.ALLOW_QA_ROUNDS === "1";
}

/** RoomManager.removePlayer: the removed player, who got the host role from them, and whether the room is now empty. */
export type RemovePlayerResult =
  | { removed: false; player?: undefined; newHost?: undefined; isEmpty: false }
  | { removed: true; player: Player; newHost?: Player; isEmpty: boolean };

export class RoomManager {
  private rooms = new Map<string, Room>();
  private roomTimeouts = new Map<string, NodeJS.Timeout>();
  // Name keys per player, computed once: a join only computes the new name's keys (EXP-032)
  private playerNameKeys = new WeakMap<Player, NameKeys>();

  createRoom(username: string, socketId: string): Room {
    const gameCode = this.generateRoomCode();
    const room: Room = {
      gameCode,
      rounds: 10,
      started: false,
      players: [this.createPlayer(username, socketId, true)],
      currentPlayer: null,
      round: 0,
      plantedPhotosShown: 0,
      plantedSlots: new Set(),
      phase: null,
      currentPhoto: null,
      paused: false,
      _pauseTimer: null,
      _pauseStartedAt: 0,
      _pauseCount: 0,
      _totalPauses: 0,
      _resumeTimer: null,
      _pauseWaitingFor: [],
      _consecutiveSkips: 0,
      _hadGuests: false,
      _timer: null,
      _timerCallback: null,
      _timerStartedAt: 0,
      _timerDuration: 0,
      held: false,
      _holdSafetyTimer: null,
      _lobbyTimer: null,
    };
    this.rooms.set(gameCode, room);
    return room;
  }

  /** True when no more rooms may be created (MAX_ROOMS). */
  isAtCapacity(): boolean {
    return this.rooms.size >= MAX_ROOMS;
  }

  /** Counts for health checks and test teardown. */
  stats(): { rooms: number; pendingDeletions: number } {
    return { rooms: this.rooms.size, pendingDeletions: this.roomTimeouts.size };
  }

  /**
   * Join or rejoin. `replacing`: username of a player in this room that the caller is about to remove
   * (same socket switching username), so its slot does not count against MAX_PLAYERS_PER_ROOM.
   * Only successful joins cancel a pending room deletion.
   */
  joinRoom(gameCode: string, username: string, socketId: string, rejoinToken?: string, replacing?: string): { success: boolean; room?: Room; message?: string; rejoin?: boolean } {
    const room = this.rooms.get(gameCode);
    if (!room) return { success: false, message: "Game not found" };

    // Re-join: same username reconnecting (e.g. after app background) — only with that player's token and the exact
    // stored name
    const others = room.players.filter((p) => p.username !== replacing);
    const existing = others.find((p) => p.username === username);
    if (existing && this.tokenMatches(existing.rejoinToken, rejoinToken)) {
      this.cancelRoomDeletion(gameCode);
      existing.socketId = socketId; // Update socket ID
      existing.connected = true;
      delete existing.disconnectedAt;
      return { success: true, room, rejoin: true };
    }

    if (room.started) return { success: false, message: "Game already started" };
    // Before comparing names, so a full room tells nothing about who is in it
    if (others.length >= MAX_PLAYERS_PER_ROOM) return { success: false, message: "Room is full" };
    // Another spelling of a player's name ("Bob", full-width "bob", "bob" with a Cyrillic o) is taken, even with that
    // player's token; a different name that only reads alike in some fonts ("AIice", "Clara" next to "Dara") is too
    // similar
    const keys = nameKeys(username);
    const clashes = others.map((p) => nameClash(this.nameKeysOf(p), keys));
    if (clashes.includes("same")) return { success: false, message: "Username already taken" };
    if (clashes.includes("similar")) return { success: false, message: "Username too similar" };
    this.cancelRoomDeletion(gameCode);
    const player = this.createPlayer(username, socketId, room.players.length === 0);
    this.playerNameKeys.set(player, keys);
    room.players.push(player);
    if (room.players.length >= 2) room._hadGuests = true;
    return { success: true, room };
  }

  private nameKeysOf(player: Player): NameKeys {
    let keys = this.playerNameKeys.get(player);
    if (!keys) {
      keys = nameKeys(player.username);
      this.playerNameKeys.set(player, keys);
    }
    return keys;
  }

  /** `username` is a player of room `gameCode` and `rejoinToken` is theirs (a join would be a rejoin). */
  canRejoin(gameCode: string, username: string, rejoinToken: unknown): boolean {
    const player = this.getPlayer(gameCode, username);
    return !!player && this.tokenMatches(player.rejoinToken, rejoinToken);
  }

  getRoom(gameCode: string): Room | undefined {
    return this.rooms.get(gameCode);
  }

  /**
   * Takes `username` out of the room: their uploads are released, a removed host hands the role to the first connected
   * player (`newHost`), and the room is deleted later if nobody connected is left (reset right away when empty).
   * Telling the room is up to the caller (GameEngine.removePlayer).
   */
  removePlayer(gameCode: string, username: string): RemovePlayerResult {
    const room = this.rooms.get(gameCode);
    if (!room) return { removed: false, isEmpty: false };
    const idx = room.players.findIndex((p) => p.username === username);
    if (idx === -1) return { removed: false, isEmpty: false };
    const player = room.players.splice(idx, 1)[0];
    this.releasePlayerUploads(room, player);
    let newHost: Player | undefined;
    if (player.isHost && room.players.length > 0) {
      newHost = room.players.find((p) => p.connected) ?? room.players[0];
      newHost.isHost = true;
    }
    if (room.players.length === 0) {
      this.resetRoom(room);
      this.scheduleRoomDeletion(gameCode);
      return { removed: true, player, isEmpty: true };
    }
    this.scheduleDeletionIfAbandoned(room);
    return { removed: true, player, newHost, isEmpty: false };
  }

  /** Mark a player offline, only if `socketId` is still their current socket (ignores stale sockets). */
  markDisconnected(gameCode: string, username: string, socketId: string): Player | undefined {
    const player = this.getPlayer(gameCode, username);
    if (!player || player.socketId !== socketId) return undefined;
    player.connected = false;
    player.disconnectedAt = Date.now();
    this.scheduleDeletionIfAbandoned(this.rooms.get(gameCode)!);
    return player;
  }

  /** Disconnected for longer than DISCONNECT_GRACE (a short absence doesn't count; no disconnect time = just now). */
  isGone(player: Player, now = Date.now()): boolean {
    return !player.connected && now - (player.disconnectedAt ?? now) >= DISCONNECT_GRACE;
  }

  /** The host is gone: the first connected player becomes host (returned). The old host stays as a normal player. */
  handOverGoneHost(room: Room): Player | undefined {
    const host = room.players.find((p) => p.isHost);
    if (host && !this.isGone(host)) return undefined;
    const next = room.players.find((p) => p.connected);
    if (!next) return undefined;
    if (host) host.isHost = false;
    next.isHost = true;
    return next;
  }

  /** A player left / was removed: their photos go, except the one on screen this round (see clearShownPhoto). */
  private releasePlayerUploads(room: Room, player: Player): void {
    uploadStore.releasePlayer(room.gameCode, player.username, this.shownUploadName(room));
  }

  /**
   * The round's photo leaves the screen (its round is over): forget it, and delete its upload now if its owner left
   * the room meanwhile, so it isn't kept until game over (EXP-116). An owner still in the room keeps it until then.
   */
  clearShownPhoto(room: Room): void {
    const name = this.shownUploadName(room);
    room.currentPhoto = null;
    if (!name) return;
    const record = uploadStore.get(name);
    if (record?.gameCode !== room.gameCode) return; // only ever this room's own uploads
    if (!room.players.some((p) => p.username === record.username)) uploadStore.remove(name);
  }

  /** Stored upload name of the photo on screen, if any. */
  private shownUploadName(room: Room): string | null {
    return room.currentPhoto ? uploadNameOf(room.currentPhoto) : null;
  }

  setRounds(gameCode: string, rounds: number): boolean {
    const room = this.rooms.get(gameCode);
    if (!room) return false;
    room.rounds = rounds;
    return true;
  }

  /** Room member whose rejoin token is `token` (constant-time compare), for HTTP access to the room's photos. */
  authenticate(gameCode: string, token: string): { room: Room; player: Player } | null {
    const room = this.rooms.get(gameCode);
    const player = room?.players.find((p) => this.tokenMatches(p.rejoinToken, token));
    return room && player ? { room, player } : null;
  }

  getPlayer(gameCode: string, username: string): Player | undefined {
    return this.rooms.get(gameCode)?.players.find((p) => p.username === username);
  }

  // ── Client-facing data (allowlists) ──

  /** room-of-game `room`: only these fields; players through publicPlayers (no owner while a photo is awaited). */
  safeRoomData(room: Room): SafeRoom {
    const { gameCode, rounds, started, round, phase, held, paused } = room;
    return { gameCode, rounds, started, round, phase, held, paused, players: this.publicPlayers(room) };
  }

  /** Every player of `room` as sent to clients, answers of the round in play hidden. */
  publicPlayers(room: Room): PublicPlayer[] {
    return room.players.map((p) => this.publicPlayer(p, room));
  }

  /**
   * The only shape in which a player is sent to clients (explicit allowlist: never socketId, rejoinToken,
   * plantedPhoto or hasPlantedPhoto, which only goes to the player themself in room-of-game; nor isReady, which
   * would tell who is still uploading a planted photo). With `room`, the
   * answer of the round in play is hidden while guessesHidden(room).
   */
  publicPlayer(player: Player, room?: Room): PublicPlayer {
    const pub: PublicPlayer = {
      username: player.username,
      points: player.points,
      isHost: player.isHost,
      connected: !this.isGone(player), // short absences are not shown (DEC-009)
      lastAnswerCorrect: player.lastAnswerCorrect,
      lastGuess: player.lastGuess,
    };
    return room && this.guessesHidden(room) ? { ...pub, ...this.hiddenGuess(player) } : pub;
  }

  /** Guesses of the round in play are secret until round-scores (in waiting-photo startRound already reset them). */
  guessesHidden(room: Room): boolean {
    return room.started && (room.phase === "answering" || room.phase === "reveal");
  }

  /** A player's answer fields as they were before this round (points without the point a correct answer earned). */
  hiddenGuess(p: Player): { points: number; lastGuess: string; lastAnswerCorrect: boolean } {
    return { points: p.points - (p.lastAnswerCorrect ? 1 : 0), lastGuess: "", lastAnswerCorrect: false };
  }

  clearAllTimers(room: Room): void {
    if (room._timer) { clearTimeout(room._timer); room._timer = null; }
    if (room._holdSafetyTimer) { clearTimeout(room._holdSafetyTimer); room._holdSafetyTimer = null; }
    if (room._pauseTimer) { clearTimeout(room._pauseTimer); room._pauseTimer = null; }
    if (room._resumeTimer) { clearTimeout(room._resumeTimer); room._resumeTimer = null; }
    if (room._lobbyTimer) { clearTimeout(room._lobbyTimer); room._lobbyTimer = null; }
    room._pauseWaitingFor = [];
    room._timerCallback = null;
    room.held = false;
    room.paused = false;
  }

  deleteRoom(gameCode: string): void {
    const room = this.rooms.get(gameCode);
    if (room) this.clearAllTimers(room);
    this.rooms.delete(gameCode);
    this.cancelRoomDeletion(gameCode);
    uploadStore.dropRoom(gameCode); // its photos go with it
  }

  /** Delete every room and cancel all their timers (server shutdown / test teardown). */
  clear(): void {
    for (const gameCode of [...this.rooms.keys()]) this.deleteRoom(gameCode);
    for (const gameCode of [...this.roomTimeouts.keys()]) this.cancelRoomDeletion(gameCode);
  }

  private createPlayer(username: string, socketId: string, isHost: boolean): Player {
    return { username, socketId, isHost, isReady: false, connected: true, points: 0, lastAnswerCorrect: false, lastGuess: "", rejoinToken: randomBytes(18).toString("base64url") };
  }

  private tokenMatches(expected: string, given: unknown): boolean {
    if (typeof given !== "string") return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private generateRoomCode(): string {
    let code: string;
    do { code = randomRoomCode(); } while (this.rooms.has(code)); // unique among live rooms
    return code;
  }

  /** Last player left: game state reset and the room's photos deleted (nobody is left to see them). */
  private resetRoom(room: Room): void {
    this.clearAllTimers(room);
    uploadStore.releaseRoom(room.gameCode);
    room.started = false;
    room.plantedPhotosShown = 0;
    room.currentPlayer = null;
    room.round = 0;
    room.phase = null;
    room.currentPhoto = null;
  }

  /** No connected player left (all disconnected without leaving): delete the room unless someone rejoins. */
  private scheduleDeletionIfAbandoned(room: Room): void {
    if (!room.players.some((p) => p.connected)) this.scheduleRoomDeletion(room.gameCode);
  }

  private scheduleRoomDeletion(gameCode: string): void {
    this.cancelRoomDeletion(gameCode);
    const delay = this.rooms.get(gameCode)?._hadGuests ? ROOM_CLEANUP_DELAY : SOLO_ROOM_CLEANUP_DELAY;
    const t = setTimeout(() => { this.roomTimeouts.delete(gameCode); this.deleteRoom(gameCode); }, delay);
    this.roomTimeouts.set(gameCode, t);
  }

  private cancelRoomDeletion(gameCode: string): void {
    const t = this.roomTimeouts.get(gameCode);
    if (t) { clearTimeout(t); this.roomTimeouts.delete(gameCode); }
  }
}
