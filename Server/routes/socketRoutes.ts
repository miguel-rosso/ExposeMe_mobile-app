import { Socket } from "socket.io";
import { io } from "../app";
import { RoomManager } from "../managers/RoomManager";
import { GameEngine } from "../managers/GameEngine";
import { JoinCreateGameData, Player, Room } from "../models/interfaces";

const roomManager = new RoomManager();
const gameEngine = new GameEngine(io, roomManager);
/** Exported for test teardown (roomManager.clear()). */
export { roomManager };

const CHAT_COOLDOWN = 250;
// join-create-game rate limit, per socket: at most JOIN_MAX_ATTEMPTS in any JOIN_WINDOW_MS
const JOIN_MAX_ATTEMPTS = 5;
const JOIN_WINDOW_MS = 10_000;
const chatCooldowns = new Map<string, number>();
const MAX_USERNAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 100;
const MAX_EMOJI_LENGTH = 16;
const MAX_PHOTO_URL_LENGTH = 2048;
// Paths returned by POST /upload: `/temp/<32 random hex>.<jpg|png|webp>` (see controllers/UploadController.ts)
const UPLOAD_PATH_RE = /^\/temp\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;

function isUploadPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PHOTO_URL_LENGTH && UPLOAD_PATH_RE.test(value);
}

/**
 * Room and player bound to this socket by a successful join-create-game.
 * Identity always comes from here, never from payload fields (gameCode/username in payloads are ignored).
 * Returns null for sockets that never joined or were superseded by a rejoin on another socket.
 */
function session(socket: Socket): { room: Room; player: Player } | null {
  const { gameCode, username } = socket.data;
  if (!gameCode || !username) return null;
  const room = roomManager.getRoom(gameCode);
  const player = room?.players.find((p) => p.username === username);
  if (!room || !player || player.socketId !== socket.id) return null;
  return { room, player };
}

/**
 * Drop a room binding of this socket, as an explicit leave. If `owned` (the socket still is that player's
 * current socket) the player is removed, host handed over and the room notified; a socket replaced by a
 * rejoin only detaches. Always leaves the socket.io room. Does not touch socket.data.
 */
function leaveBinding(socket: Socket, gameCode: string, username: string, owned: boolean): void {
  const room = roomManager.getRoom(gameCode);
  if (owned && room) {
    if (room.held && room.currentPlayer?.socketId === socket.id) gameEngine.forceRelease(room);

    console.log(`[${gameCode}] ${username} left voluntarily`);
    const result = roomManager.removePlayer(gameCode, username);
    if (result.removed) {
      if (result.newHost) io.to(gameCode).emit("new-host", roomManager.publicPlayer(result.newHost));
      if (!result.isEmpty) io.to(gameCode).emit("player-left", username);
      gameEngine.checkReady(room); // ready phase: the others may all be ready now
      gameEngine.onConnectionChange(room); // mid-game: pause (or end) if fewer than 2 remain connected
    }
  }
  socket.leave(gameCode);
}

/**
 * Cut a socket off a room for good: out of the socket.io room (no more broadcasts such as round-start photo
 * URLs), session cleared (its later events and its disconnect are ignored), connection closed.
 */
function evictSocket(target: Socket, gameCode: string): void {
  target.leave(gameCode);
  target.data.gameCode = null;
  target.data.username = null;
  target.disconnect(true);
}

/** Every socket in the room bound to `username` (live, replaced or stale), except `exceptId`. */
function socketsOf(gameCode: string, username: string, exceptId?: string): Socket[] {
  const ids = io.sockets.adapter.rooms.get(gameCode) ?? new Set<string>();
  return [...ids]
    .map((id) => io.sockets.sockets.get(id))
    .filter((s): s is Socket => !!s && s.id !== exceptId && s.data.username === username);
}

function leaveCurrentRoom(socket: Socket): void {
  const { gameCode, username } = socket.data;
  if (!gameCode || !username) return;
  leaveBinding(socket, gameCode, username, session(socket) !== null);
  socket.data.gameCode = null;
  socket.data.username = null;
}

io.on("connection", (socket: Socket) => {
  console.log(`Connected: ${socket.id}`);
  const joinAttempts: number[] = []; // timestamps of recent join-create-game events on this socket

  // ── Lobby ──────────────────────────────────────────

  socket.on("join-create-game", (data: JoinCreateGameData) => {
    try {
      const now = Date.now();
      while (joinAttempts.length && now - joinAttempts[0] >= JOIN_WINDOW_MS) joinAttempts.shift();
      if (joinAttempts.length >= JOIN_MAX_ATTEMPTS) {
        socket.emit("room-of-game", { success: false, message: "Too many attempts" });
        return;
      }
      joinAttempts.push(now);

      const username = data?.username;
      let gameCode = data?.gameCode;
      if (typeof username !== "string" || !username.trim() || username.length > MAX_USERNAME_LENGTH) {
        socket.emit("room-of-game", { success: false, message: "Invalid username" });
        return;
      }
      if (gameCode != null && typeof gameCode !== "string") {
        socket.emit("room-of-game", { success: false, message: "Game not found" });
        return;
      }

      if (gameCode) gameCode = gameCode.toUpperCase();

      // One socket = one player in one room. The same live socket re-sending join for the room and username
      // it already owns (WaitingRoom effect re-run, duplicate join) is a no-op. Reconnects and "Play again"
      // arrive on a new socket and go through the normal rejoin (token) path below.
      const current = session(socket);
      if (current && gameCode === current.room.gameCode && username === current.player.username) {
        const { room, player } = current;
        socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(room), rounds: room.rounds, rejoinToken: player.rejoinToken });
        // Game in progress: the app asks again from the game screen, which missed the rejoin snapshot
        gameEngine.resendState(room, player);
        return;
      }

      // Any other join first tries the new binding; only on success is the previous one left
      // (player removed, host handed over). A failed join keeps the socket where it was.
      const prevCode: string | null = socket.data.gameCode ?? null;
      const prevUsername: string | null = socket.data.username ?? null;
      const leavePrevious = () => {
        if (!prevCode || !prevUsername || (prevCode === gameCode && prevUsername === username)) return;
        leaveBinding(socket, prevCode, prevUsername, current !== null);
      };

      if (gameCode) {
        // Same room under another username: the socket's own player frees its slot
        const replacing = current && current.room.gameCode === gameCode ? current.player.username : undefined;
        const result = roomManager.joinRoom(gameCode, username, socket.id, data.rejoinToken, replacing);
        if (result.success && result.room) {
          const player = roomManager.getPlayer(gameCode, username)!;
          leavePrevious();
          socket.join(gameCode);
          socket.data.gameCode = gameCode;
          socket.data.username = username;
          // rejoinToken goes only to this socket
          socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(result.room), rounds: result.room.rounds, rejoinToken: player.rejoinToken });
          // Only broadcast player-joined for new players, not rejoins
          if (!result.rejoin) socket.broadcast.to(gameCode).emit("player-joined", roomManager.publicPlayer(player));
          // A rejoin replaces the player's previous socket(s): they must not keep receiving the room's events
          if (result.rejoin) socketsOf(gameCode, username, socket.id).forEach((old) => evictSocket(old, gameCode));
          console.log(`[${gameCode}] ${username} ${result.rejoin ? "rejoined" : "joined"}`);
          // Reconnect: snapshot of the current game to this socket, and resume a paused game
          if (result.rejoin) gameEngine.onPlayerRejoined(result.room, player);
        } else {
          socket.emit("room-of-game", { success: false, message: result.message });
        }
      } else {
        if (roomManager.isAtCapacity()) {
          socket.emit("room-of-game", { success: false, message: "Server is busy" });
          return;
        }
        const room = roomManager.createRoom(username, socket.id);
        leavePrevious();
        socket.join(room.gameCode);
        socket.data.gameCode = room.gameCode;
        socket.data.username = username;
        socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(room), rejoinToken: room.players[0].rejoinToken });
      }
    } catch (e) { console.error("join-create-game error:", e); }
  });

  socket.on("disconnect", () => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;

      const room = roomManager.getRoom(gameCode);
      if (!room) return;

      // Release hold if this player was holding
      if (room.held && room.currentPlayer?.socketId === socket.id) gameEngine.forceRelease(room);

      chatCooldowns.delete(socket.id);

      const player = roomManager.markDisconnected(gameCode, username, socket.id);
      if (!player) {
        console.log(`[${gameCode}] ${username} old socket disconnected — already reconnected, ignoring`);
        return;
      }

      // Keep all players in room on disconnect — they can rejoin.
      // Room gets cleaned up after 30min inactivity.
      console.log(`[${gameCode}] ${username} disconnected — keeping in room`);
      gameEngine.checkReady(room); // ready phase: don't wait for a player who is gone
      gameEngine.onConnectionChange(room); // mid-game: pause if fewer than 2 players remain connected
    } catch (e) { console.error("disconnect error:", e); }
  });

  // Explicit leave — player pressed the leave button
  socket.on("leave-room", () => {
    try {
      // A socket replaced by a rejoin only detaches itself; the live player stays
      leaveCurrentRoom(socket);
    } catch (e) { console.error("leave-room error:", e); }
  });

  // Payload gameCode is ignored: host-only, applies to the host's own room
  socket.on("set-rounds", (data: { rounds: number }) => {
    try {
      const s = session(socket);
      if (!s || !s.player.isHost || s.room.started) return;
      if (![10, 15, 20].includes(data?.rounds)) return;
      if (roomManager.setRounds(s.room.gameCode, data.rounds)) io.to(s.room.gameCode).emit("rounds-updated", data.rounds);
    } catch (e) { console.error("set-rounds error:", e); }
  });

  socket.on("start-game", () => {
    try {
      const s = session(socket);
      if (!s || !s.player.isHost || s.room.started) return;
      gameEngine.startGame(s.room);
    } catch (e) { console.error("start-game error:", e); }
  });

  socket.on("im-ready", () => {
    try {
      const s = session(socket);
      if (!s) return;
      gameEngine.markReady(s.room, s.player);
    } catch (e) { console.error("im-ready error:", e); }
  });

  // ── In-game ────────────────────────────────────────

  // Only the current photo owner, and only with a path returned by /upload
  socket.on("photo-sent", (data: { photo: string }) => {
    try {
      const s = session(socket);
      if (!s || !isUploadPath(data?.photo)) return;
      gameEngine.onPhotoReceived(s.room, data.photo, s.player.username);
    } catch (e) { console.error("photo-sent error:", e); }
  });

  const onAnswer = (data: { guess: string }) => {
    const s = session(socket);
    if (!s) return;
    const guess = typeof data?.guess === "string" && data.guess.length <= MAX_USERNAME_LENGTH ? data.guess : "";
    gameEngine.recordAnswer(s.room, s.player.username, guess);
  };

  socket.on("submit-answer", (data: { guess: string }) => {
    try { onAnswer(data); } catch (e) { console.error("submit-answer error:", e); }
  });

  // Legacy answer events → same handler
  socket.on("correct-answer", (data: { guess: string }) => {
    try { onAnswer(data); } catch (e) { console.error("answer error:", e); }
  });
  socket.on("incorrect-answer", (data: { guess: string }) => {
    try { onAnswer(data); } catch (e) { console.error("answer error:", e); }
  });

  // ── Hold ───────────────────────────────────────────

  socket.on("hold-start", () => {
    try {
      const { gameCode } = socket.data;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      if (gameEngine.handleHold(room, socket.id)) {
        io.to(gameCode).emit("hold-start");
      }
    } catch (e) { console.error("hold-start error:", e); }
  });

  socket.on("hold-end", () => {
    try {
      const { gameCode } = socket.data;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      if (gameEngine.handleRelease(room, socket.id)) {
        // hold-resume is emitted by doRelease in GameEngine
        // hold-end tells clients the hold is over
        io.to(gameCode).emit("hold-end");
      }
    } catch (e) { console.error("hold-end error:", e); }
  });

  // ── Social ─────────────────────────────────────────

  // Social events: payload gameCode/username are ignored, the session decides room and sender

  socket.on("emoji-reaction", (data: { emoji: string }) => {
    try {
      const s = session(socket);
      const emoji = data?.emoji;
      if (!s || typeof emoji !== "string" || !emoji || emoji.length > MAX_EMOJI_LENGTH) return;
      io.to(s.room.gameCode).emit("emoji-reaction", { username: s.player.username, emoji });
    } catch (e) { console.error("emoji error:", e); }
  });

  socket.on("mark-player-planted", () => {
    try {
      const s = session(socket);
      if (s) s.player.hasPlantedPhoto = true;
    } catch (e) { console.error("mark-planted error:", e); }
  });

  socket.on("plant-photo", (data: { photoUrl: string }) => {
    try {
      const s = session(socket);
      const photoUrl = data?.photoUrl;
      if (!s || !isUploadPath(photoUrl)) return;
      const { room, player } = s;
      // Accept planted photos until the first round actually starts playing
      if (room.phase === "answering" || room.phase === "reveal" || room.phase === "scores") return;
      player.plantedPhoto = photoUrl;
      console.log(`[${room.gameCode}] Planted photo received from ${player.username}`);
    } catch (e) { console.error("plant-photo error:", e); }
  });

  socket.on("chat-message", (data: { message: string }) => {
    try {
      const s = session(socket);
      const message = data?.message;
      if (!s || typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_LENGTH) return;
      const now = Date.now();
      if (now - (chatCooldowns.get(socket.id) ?? 0) < CHAT_COOLDOWN) return;
      chatCooldowns.set(socket.id, now);
      socket.broadcast.to(s.room.gameCode).emit("chat-message", { username: s.player.username, message });
    } catch (e) { console.error("chat error:", e); }
  });

  socket.on("remove-player", (data: { socketId: string }) => {
    try {
      const s = session(socket);
      if (!s || !s.player.isHost || typeof data?.socketId !== "string") return;
      const { room } = s;
      const removed = roomManager.removePlayerBySocketId(room.gameCode, data.socketId);
      if (removed) {
        io.to(room.gameCode).emit("player-removed", roomManager.publicPlayer(removed));
        // The kicked player's current socket and any other socket still bound to them in this room
        const target = io.sockets.sockets.get(data.socketId);
        if (target) evictSocket(target, room.gameCode);
        socketsOf(room.gameCode, removed.username).forEach((old) => evictSocket(old, room.gameCode));
        gameEngine.checkReady(room);
        gameEngine.onConnectionChange(room);
      }
    } catch (e) { console.error("remove-player error:", e); }
  });
});
