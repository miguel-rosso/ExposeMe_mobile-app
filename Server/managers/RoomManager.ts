import { randomBytes, timingSafeEqual } from "crypto";
import { Player, PublicPlayer, Room, SafeRoom } from "../models/interfaces";

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;
/** Cleanup delay for rooms that never had a second player (created and abandoned). */
const SOLO_ROOM_CLEANUP_DELAY = 2 * 60 * 1000;
export const MAX_PLAYERS_PER_ROOM = 12;
/** Global cap on rooms held in memory; creating beyond it is refused with "Server is busy". */
export const MAX_ROOMS = 5000;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private roomTimeouts = new Map<string, NodeJS.Timeout>();

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

    // Re-join: same username reconnecting (e.g. after app background) — only with that player's token
    const existing = room.players.find((p) => p.username === username);
    if (existing && !this.tokenMatches(existing.rejoinToken, rejoinToken)) {
      return { success: false, message: room.started ? "Game already started" : "Username already taken" };
    }

    if (existing) {
      this.cancelRoomDeletion(gameCode);
      existing.socketId = socketId; // Update socket ID
      existing.connected = true;
      return { success: true, room, rejoin: true };
    }

    if (room.started) return { success: false, message: "Game already started" };
    const taken = room.players.filter((p) => p.username !== replacing).length;
    if (taken >= MAX_PLAYERS_PER_ROOM) return { success: false, message: "Room is full" };
    this.cancelRoomDeletion(gameCode);
    room.players.push(this.createPlayer(username, socketId, room.players.length === 0));
    if (room.players.length >= 2) room._hadGuests = true;
    return { success: true, room };
  }

  getRoom(gameCode: string): Room | undefined {
    return this.rooms.get(gameCode);
  }

  removePlayer(gameCode: string, username: string): { removed: boolean; player?: Player; newHost?: Player; isEmpty: boolean } {
    const room = this.rooms.get(gameCode);
    if (!room) return { removed: false, isEmpty: false };
    const idx = room.players.findIndex((p) => p.username === username);
    if (idx === -1) return { removed: false, isEmpty: false };
    const player = room.players.splice(idx, 1)[0];
    let newHost: Player | undefined;
    if (player.isHost && room.players.length > 0) {
      room.players[0].isHost = true;
      newHost = room.players[0];
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
    this.scheduleDeletionIfAbandoned(this.rooms.get(gameCode)!);
    return player;
  }

  removePlayerBySocketId(gameCode: string, socketId: string): Player | undefined {
    const room = this.rooms.get(gameCode);
    if (!room) return undefined;
    const idx = room.players.findIndex((p) => p.socketId === socketId);
    if (idx === -1) return undefined;
    return room.players.splice(idx, 1)[0];
  }

  setRounds(gameCode: string, rounds: number): boolean {
    const room = this.rooms.get(gameCode);
    if (!room) return false;
    room.rounds = rounds;
    return true;
  }

  getPlayer(gameCode: string, username: string): Player | undefined {
    return this.rooms.get(gameCode)?.players.find((p) => p.username === username);
  }

  safeRoomData(room: Room): SafeRoom {
    const { _timer, _timerCallback, _timerStartedAt, _timerDuration, _holdSafetyTimer, _pauseTimer, _pauseStartedAt, _pauseCount, _resumeTimer, _pauseWaitingFor, plantedSlots, _consecutiveSkips, _hadGuests, ...safe } = room;
    return {
      ...safe,
      players: safe.players.map((p) => this.publicPlayer(p)),
      currentPlayer: safe.currentPlayer ? this.publicPlayer(safe.currentPlayer) : null,
    };
  }

  /** Player data that is safe to send to other clients (drops the rejoin token and planted photo URL). */
  publicPlayer(player: Player): PublicPlayer {
    const { rejoinToken, plantedPhoto, ...pub } = player;
    return pub;
  }

  clearAllTimers(room: Room): void {
    if (room._timer) { clearTimeout(room._timer); room._timer = null; }
    if (room._holdSafetyTimer) { clearTimeout(room._holdSafetyTimer); room._holdSafetyTimer = null; }
    if (room._pauseTimer) { clearTimeout(room._pauseTimer); room._pauseTimer = null; }
    if (room._resumeTimer) { clearTimeout(room._resumeTimer); room._resumeTimer = null; }
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
    do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (this.rooms.has(code));
    return code;
  }

  private resetRoom(room: Room): void {
    this.clearAllTimers(room);
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
