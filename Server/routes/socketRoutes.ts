import { Socket } from "socket.io";
import { io } from "../app";
import { RoomManager } from "../managers/RoomManager";
import { GameEngine } from "../managers/GameEngine";
import { JoinCreateGameData, PlayerId } from "../models/interfaces";

const roomManager = new RoomManager();
const gameEngine = new GameEngine(io, roomManager);

const CHAT_COOLDOWN = 250;
const chatCooldowns = new Map<string, number>();

io.on("connection", (socket: Socket) => {
  console.log(`Connected: ${socket.id}`);

  // ── Lobby ──────────────────────────────────────────

  socket.on("join-create-game", (data: JoinCreateGameData) => {
    try {
      const { username } = data;
      let { gameCode } = data;

      if (gameCode) {
        gameCode = gameCode.toUpperCase();
        const result = roomManager.joinRoom(gameCode, username, socket.id);
        if (result.success && result.room) {
          socket.join(gameCode);
          socket.data.gameCode = gameCode;
          socket.data.username = username;
          socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(result.room), rounds: result.room.rounds });
          // Only broadcast player-joined for new players, not rejoins
          if (!result.rejoin) {
            const newPlayer = result.room.players[result.room.players.length - 1];
            socket.broadcast.to(gameCode).emit("player-joined", newPlayer);
          }
          console.log(`[${gameCode}] ${username} ${result.rejoin ? "rejoined" : "joined"}`);
        } else {
          socket.emit("room-of-game", { success: false, message: result.message });
        }
      } else {
        const room = roomManager.createRoom(username, socket.id);
        socket.join(room.gameCode);
        socket.data.gameCode = room.gameCode;
        socket.data.username = username;
        socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(room) });
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

      // Remove player from room
      console.log(`[${gameCode}] ${username} disconnected`);
      const result = roomManager.removePlayer(gameCode, username);
      if (!result.removed) return;
      if (result.newHost) io.to(gameCode).emit("new-host", result.newHost);
      if (!result.isEmpty) io.to(gameCode).emit("player-left", username);
    } catch (e) { console.error("disconnect error:", e); }
  });

  socket.on("set-rounds", (data: { gameCode: string; rounds: number }) => {
    try {
      if (![10, 15, 20].includes(data.rounds)) return;
      if (roomManager.setRounds(data.gameCode, data.rounds)) io.to(data.gameCode).emit("rounds-updated", data.rounds);
    } catch (e) { console.error("set-rounds error:", e); }
  });

  socket.on("start-game", (data: { gameCode: string }) => {
    try {
      const room = roomManager.getRoom(data.gameCode);
      if (!room) return;
      if (!room.players.find((p) => p.socketId === socket.id)?.isHost) return;
      gameEngine.startGame(room);
    } catch (e) { console.error("start-game error:", e); }
  });

  socket.on("im-ready", (data: PlayerId) => {
    try {
      const room = roomManager.getRoom(data.gameCode);
      if (!room) return;
      const player = room.players.find((p) => p.username === data.username);
      if (player) player.isReady = true;
      // Guard: only start once (phase is null before first start)
      if (room.phase === null && room.players.every((p) => p.isReady)) {
        room.phase = "waiting-photo"; // Mark as started to prevent double-trigger
        gameEngine.onAllPlayersReady(room);
      }
    } catch (e) { console.error("im-ready error:", e); }
  });

  // ── In-game ────────────────────────────────────────

  socket.on("photo-sent", (data: { photo: string }) => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      gameEngine.onPhotoReceived(room, data.photo, username);
    } catch (e) { console.error("photo-sent error:", e); }
  });

  socket.on("submit-answer", (data: { guess: string }) => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      gameEngine.recordAnswer(room, username, data.guess);
    } catch (e) { console.error("submit-answer error:", e); }
  });

  // Legacy answer events → same handler
  socket.on("correct-answer", (data: { guess: string }) => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      gameEngine.recordAnswer(room, username, data.guess);
    } catch (e) { console.error("answer error:", e); }
  });
  socket.on("incorrect-answer", (data: { guess: string }) => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;
      const room = roomManager.getRoom(gameCode);
      if (!room) return;
      gameEngine.recordAnswer(room, username, data.guess);
    } catch (e) { console.error("answer error:", e); }
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

  socket.on("emoji-reaction", (data: { gameCode: string; username: string; emoji: string }) => {
    try { io.to(data.gameCode).emit("emoji-reaction", { username: data.username, emoji: data.emoji }); }
    catch (e) { console.error("emoji error:", e); }
  });

  socket.on("mark-player-planted", (data: { gameCode: string; username: string }) => {
    try {
      const player = roomManager.getPlayer(data.gameCode, data.username);
      if (player) player.hasPlantedPhoto = true;
    } catch (e) { console.error("mark-planted error:", e); }
  });

  socket.on("plant-photo", (data: { gameCode: string; username: string; photoUrl: string }) => {
    try {
      const room = roomManager.getRoom(data.gameCode);
      if (!room) return;
      // Accept planted photos until the first round actually starts playing
      if (room.phase === "answering" || room.phase === "reveal" || room.phase === "scores") return;
      const player = room.players.find((p) => p.username === data.username);
      if (player) {
        player.plantedPhoto = data.photoUrl;
        console.log(`[${room.gameCode}] Planted photo received from ${data.username}`);
      }
    } catch (e) { console.error("plant-photo error:", e); }
  });

  socket.on("chat-message", (data: { gameCode: string; username: string; message: string }) => {
    try {
      if (!data.message.trim() || data.message.length > 100) return;
      const now = Date.now();
      if (now - (chatCooldowns.get(socket.id) ?? 0) < CHAT_COOLDOWN) return;
      chatCooldowns.set(socket.id, now);
      socket.broadcast.to(data.gameCode).emit("chat-message", { username: data.username, message: data.message });
    } catch (e) { console.error("chat error:", e); }
  });

  socket.on("remove-player", (data: { gameCode: string; socketId: string }) => {
    try {
      const room = roomManager.getRoom(data.gameCode);
      if (!room || !room.players.find((p) => p.socketId === socket.id)?.isHost) return;
      const removed = roomManager.removePlayerBySocketId(data.gameCode, data.socketId);
      if (removed) {
        io.to(room.gameCode).emit("player-removed", removed);
        const s = io.sockets.sockets.get(data.socketId);
        if (s) { s.leave(data.gameCode); s.disconnect(true); }
      }
    } catch (e) { console.error("remove-player error:", e); }
  });
});
