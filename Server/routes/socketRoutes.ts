import { Socket } from "socket.io";
import { io } from "../app";
import { RoomManager } from "../managers/RoomManager";
import { GameEngine } from "../managers/GameEngine";
import { JoinCreateGameData, Player, Room } from "../models/interfaces";

const roomManager = new RoomManager();
const gameEngine = new GameEngine(io, roomManager);

const CHAT_COOLDOWN = 250;
const chatCooldowns = new Map<string, number>();
const MAX_USERNAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 100;
const MAX_EMOJI_LENGTH = 16;
const MAX_PHOTO_URL_LENGTH = 2048;
// Paths returned by POST /upload: `/temp/${Date.now()}-${originalname}` (see middlewares/upload.ts)
const UPLOAD_PATH_RE = /^\/temp\/\d+-[A-Za-z0-9._-]+$/;

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

io.on("connection", (socket: Socket) => {
  console.log(`Connected: ${socket.id}`);

  // ── Lobby ──────────────────────────────────────────

  socket.on("join-create-game", (data: JoinCreateGameData) => {
    try {
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

      if (gameCode) {
        gameCode = gameCode.toUpperCase();
        const result = roomManager.joinRoom(gameCode, username, socket.id, data.rejoinToken);
        if (result.success && result.room) {
          const player = roomManager.getPlayer(gameCode, username)!;
          socket.join(gameCode);
          socket.data.gameCode = gameCode;
          socket.data.username = username;
          // rejoinToken goes only to this socket
          socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(result.room), rounds: result.room.rounds, rejoinToken: player.rejoinToken });
          // Only broadcast player-joined for new players, not rejoins
          if (!result.rejoin) socket.broadcast.to(gameCode).emit("player-joined", roomManager.publicPlayer(player));
          console.log(`[${gameCode}] ${username} ${result.rejoin ? "rejoined" : "joined"}`);
        } else {
          socket.emit("room-of-game", { success: false, message: result.message });
        }
      } else {
        const room = roomManager.createRoom(username, socket.id);
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
    } catch (e) { console.error("disconnect error:", e); }
  });

  // Explicit leave — player pressed the leave button
  socket.on("leave-room", () => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;

      // A socket replaced by a rejoin only detaches itself; the live player stays
      const s = session(socket);
      if (s) {
        const { room } = s;
        if (room.held && room.currentPlayer?.socketId === socket.id) gameEngine.forceRelease(room);

        console.log(`[${gameCode}] ${username} left voluntarily`);
        const result = roomManager.removePlayer(gameCode, username);
        if (result.removed) {
          if (result.newHost) io.to(gameCode).emit("new-host", roomManager.publicPlayer(result.newHost));
          if (!result.isEmpty) io.to(gameCode).emit("player-left", username);
        }
      }

      socket.leave(gameCode);
      socket.data.gameCode = null;
      socket.data.username = null;
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
      const { room, player } = s;
      // Only counts between game-started and the first round (phase is null until all are ready)
      if (!room.started || room.phase !== null) return;
      player.isReady = true;
      if (room.players.every((p) => p.isReady)) {
        room.phase = "waiting-photo"; // Mark as started to prevent double-trigger
        gameEngine.onAllPlayersReady(room);
      }
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
        const target = io.sockets.sockets.get(data.socketId);
        if (target) { target.leave(room.gameCode); target.disconnect(true); }
      }
    } catch (e) { console.error("remove-player error:", e); }
  });
});
