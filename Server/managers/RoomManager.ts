import { Player, Room } from "../models/interfaces";

const ROOM_CLEANUP_DELAY = 30 * 60 * 1000;

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

  joinRoom(gameCode: string, username: string, socketId: string): { success: boolean; room?: Room; message?: string; rejoin?: boolean } {
    const room = this.rooms.get(gameCode);
    if (!room) return { success: false, message: "Game not found" };

    this.cancelRoomDeletion(gameCode);

    // Re-join: same username reconnecting (e.g. after app background)
    const existing = room.players.find((p) => p.username === username);
    if (existing) {
      existing.socketId = socketId; // Update socket ID
      return { success: true, room, rejoin: true };
    }

    if (room.started) return { success: false, message: "Game already started" };
    room.players.push(this.createPlayer(username, socketId, room.players.length === 0));
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
    return { removed: true, player, newHost, isEmpty: false };
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

  safeRoomData(room: Room): Omit<Room, "_timer" | "_timerCallback" | "_timerStartedAt" | "_timerDuration" | "_holdSafetyTimer" | "plantedSlots"> {
    const { _timer, _timerCallback, _timerStartedAt, _timerDuration, _holdSafetyTimer, plantedSlots, ...safe } = room;
    return {
      ...safe,
      currentPlayer: safe.currentPlayer ? { ...safe.currentPlayer, plantedPhoto: undefined } : null,
    };
  }

  clearAllTimers(room: Room): void {
    if (room._timer) { clearTimeout(room._timer); room._timer = null; }
    if (room._holdSafetyTimer) { clearTimeout(room._holdSafetyTimer); room._holdSafetyTimer = null; }
    room._timerCallback = null;
    room.held = false;
  }

  deleteRoom(gameCode: string): void {
    const room = this.rooms.get(gameCode);
    if (room) this.clearAllTimers(room);
    this.rooms.delete(gameCode);
    this.cancelRoomDeletion(gameCode);
  }

  private createPlayer(username: string, socketId: string, isHost: boolean): Player {
    return { username, socketId, isHost, isReady: false, points: 0, lastAnswerCorrect: false, lastGuess: "" };
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
  }

  private scheduleRoomDeletion(gameCode: string): void {
    const t = setTimeout(() => { this.rooms.delete(gameCode); this.roomTimeouts.delete(gameCode); }, ROOM_CLEANUP_DELAY);
    this.roomTimeouts.set(gameCode, t);
  }

  private cancelRoomDeletion(gameCode: string): void {
    const t = this.roomTimeouts.get(gameCode);
    if (t) { clearTimeout(t); this.roomTimeouts.delete(gameCode); }
  }
}
