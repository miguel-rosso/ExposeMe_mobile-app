import { Socket } from "socket.io";
import { io } from "../app";
import { isAllowedRounds, RoomManager } from "../managers/RoomManager";
import { GameEngine } from "../managers/GameEngine";
import { isRoomCode, normalizeRoomCode } from "../managers/roomCode";
import { acceptsPlantedPhoto, setUploadRooms } from "../middlewares/uploadAccess";
import { uploadStore } from "../middlewares/uploadStore";
import { createSlidingWindow } from "../middlewares/rateLimit";
import {
  ALLOWED_EMOJIS, createConnectionCounter, createEventLimiter, createJoinMissGuard, createTokenBucket, EMOJI_BURST, EMOJI_RATE_PER_S,
  GAME_EVENT_LIMITS, handshakeKey,
  HOLD_START_BURST, HOLD_START_RATE_PER_S, JOIN_EXEMPT_MAX, JOIN_MISS_GLOBAL_MAX, JOIN_MISS_HARD_FACTOR, JOIN_MISS_MAX,
  JOIN_MISS_PREFIX_MAX, JOIN_MISS_PRESSURE_MAX, JOIN_MISS_SOCKET_INTERVAL_MS, JOIN_MISS_WINDOW_MS, MAX_CONNECTIONS_PER_IP,
} from "../managers/socketGuards";
import { createQaTelemetry, isQaAck, QA_ACK_BURST, QA_ACK_RATE_PER_S } from "../managers/qaTelemetry";
import { JoinCreateGameData, PhotoUnavailableData, Player, Room } from "../models/interfaces";

const roomManager = new RoomManager();
const gameEngine = new GameEngine(io, roomManager);
// POST /upload and GET /temp authenticate room members against these rooms
setUploadRooms(roomManager);
/** Exported for test teardown (roomManager.clear()). */
export { roomManager };

const CHAT_COOLDOWN = 250;
// join-create-game rate limit, per socket: at most JOIN_MAX_ATTEMPTS in any JOIN_WINDOW_MS
const JOIN_MAX_ATTEMPTS = 5;
const JOIN_WINDOW_MS = 10_000;
const chatCooldowns = new Map<string, number>();
// submit-answer rate limit, per socket: token bucket of ANSWER_BURST refilled at ANSWER_RATE_PER_S
const ANSWER_BURST = 10;
const ANSWER_RATE_PER_S = 5;
const MAX_USERNAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 100;
// Per-IP limits (see managers/socketGuards): open sockets, and join attempts with a code that matches no room
const connections = createConnectionCounter(MAX_CONNECTIONS_PER_IP);
// Per IP key, per IPv6 /48 and global budget (see createJoinMissGuard)
const joinMisses = createJoinMissGuard({
  max: JOIN_MISS_MAX, windowMs: JOIN_MISS_WINDOW_MS, hardFactor: JOIN_MISS_HARD_FACTOR,
  prefixMax: JOIN_MISS_PREFIX_MAX, globalMax: JOIN_MISS_GLOBAL_MAX, pressureMax: JOIN_MISS_PRESSURE_MAX,
});
const joinExemptions = createSlidingWindow({ max: JOIN_EXEMPT_MAX, windowMs: JOIN_MISS_WINDOW_MS });
// One socket.io socket per engine.io connection (a second CONNECT on the same transport is refused)
const connsWithSocket = new WeakSet<object>();
// Dev/QA only (QA_TELEMETRY=1): records when each device rendered a phase; null in production (no qa-ack handler)
const qaTelemetry = createQaTelemetry();
/** Exported for tests: open connections per IP key, join misses per IP key. */
export { connections, joinMisses };

/** Some connected player of `room` is on the same IP key as the sender (that network already knows the code). */
function hasMemberOnIp(room: Room, ip: string): boolean {
  return room.players.some((p) => p.connected && io.sockets.sockets.get(p.socketId)?.data.ip === ip);
}
const MAX_PHOTO_URL_LENGTH = 2048;
// Paths returned by POST /upload: `/temp/<32 random hex>.<jpg|png|webp>` (see controllers/UploadController.ts)
const UPLOAD_PATH_RE = /^\/temp\/[0-9a-f]{32}\.(?:jpg|png|webp)$/;

function isUploadPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PHOTO_URL_LENGTH && UPLOAD_PATH_RE.test(value);
}

/** A /upload path that this player uploaded in this room (and that hasn't been deleted). */
function isOwnUpload(value: unknown, room: Room, player: Player): value is string {
  if (!isUploadPath(value)) return false;
  const record = uploadStore.get(value.slice("/temp/".length));
  return record?.gameCode === room.gameCode && record.username === player.username;
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

/** The photo owner on `socketId` is holding the scores screen right now. */
function isHolding(room: Room, socketId: string): boolean {
  return !!room.held && room.currentPlayer?.socketId === socketId;
}

/**
 * The photo owner on `socketId` is going away (leave, kick, disconnect): end their hold of the scores screen now
 * (hold-end + hold-resume) instead of leaving everyone frozen until the hold budget runs out.
 */
function releaseHoldOf(room: Room, socketId: string): void {
  if (isHolding(room, socketId)) gameEngine.forceRelease(room);
}

/**
 * Drop a room binding of this socket, as an explicit leave. If `owned` (the socket still is that player's
 * current socket) the player is removed, host handed over and the room notified; a socket replaced by a
 * rejoin only detaches. Always leaves the socket.io room. Does not touch socket.data.
 */
function leaveBinding(socket: Socket, gameCode: string, username: string, owned: boolean): void {
  const room = roomManager.getRoom(gameCode);
  if (owned && room) {
    releaseHoldOf(room, socket.id);

    console.log(`[${gameCode}] ${username} left voluntarily`);
    const result = roomManager.removePlayer(gameCode, username);
    if (result.removed) {
      if (result.newHost) io.to(gameCode).emit("new-host", roomManager.publicPlayer(result.newHost, room));
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

// Per-IP cap on concurrent connections. Counted per engine.io connection, whose "close" always fires (also when the
// socket.io handshake never completes), and checked when the socket.io handshake arrives. Connections that never
// complete one are closed by socket.io's connectTimeout.
io.engine.on("connection", (conn: { request: Parameters<typeof handshakeKey>[0]; once: (ev: "close", fn: () => void) => void }) => {
  const ip = handshakeKey(conn.request);
  connections.acquire(ip);
  conn.once("close", () => connections.release(ip));
});

io.use((socket, next) => {
  const ip = handshakeKey(socket.request);
  if (connections.over(ip) || connsWithSocket.has(socket.conn)) return next(new Error("Too many connections"));
  connsWithSocket.add(socket.conn);
  socket.data.ip = ip;
  next();
});

io.on("connection", (socket: Socket) => {
  console.log(`Connected: ${socket.id}`);
  const ip: string = socket.data.ip;
  const joinAttempts: number[] = []; // timestamps of recent join-create-game events on this socket
  let lastMissAt = -Infinity;
  /**
   * An unknown code: counts against the IP (and its IPv6 /48, and the global budget), at most once per
   * JOIN_MISS_SOCKET_INTERVAL_MS per socket. Also while locked (towards the hard ceiling).
   */
  const missCooldown = () => Date.now() - lastMissAt < JOIN_MISS_SOCKET_INTERVAL_MS;
  const recordMiss = () => {
    if (missCooldown()) return;
    lastMissAt = Date.now();
    joinMisses.record(ip);
  };
  /** Locked IP: a connected player of `room` on this IP lets the join through, unless past the hard ceiling or the exemption cap. */
  const sameNetworkExempt = (room: Room | undefined): boolean => {
    if (!room || joinMisses.hardLocked(ip) || joinExemptions.retryAfter(ip) || !hasMemberOnIp(room, ip)) return false;
    joinExemptions.hit(ip);
    return true;
  };
  // Per-socket token buckets of the lobby/game events below (GAME_EVENT_LIMITS); excess dropped silently
  const gameEvents = createEventLimiter(GAME_EVENT_LIMITS);

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
      const rawCode = data?.gameCode;
      if (typeof username !== "string" || !username.trim() || username.length > MAX_USERNAME_LENGTH) {
        socket.emit("room-of-game", { success: false, message: "Invalid username" });
        return;
      }
      if (rawCode != null && typeof rawCode !== "string") {
        recordMiss();
        socket.emit("room-of-game", { success: false, message: "Game not found" });
        return;
      }
      // No code (null/"") creates a room; any other string is a code to join, typed in any case
      const gameCode = rawCode ? normalizeRoomCode(rawCode) : null;

      // One socket = one player in one room. The same live socket re-sending join for the room and username
      // it already owns (WaitingRoom effect re-run, duplicate join) is a no-op. Reconnects and "Play again"
      // arrive on a new socket and go through the normal rejoin (token) path below.
      const current = session(socket);
      if (current && gameCode === current.room.gameCode && username === current.player.username) {
        const { room, player } = current;
        socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(room), rounds: room.rounds, rejoinToken: player.rejoinToken, hasPlantedPhoto: !!player.hasPlantedPhoto });
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

      if (gameCode !== null) {
        // This IP guessed too many unknown codes: no answer reveals whether this code exists, unless the sender
        // proves it is a player of that room (rejoin with its token) or a connected player of the room is on the
        // same IP (same network: they know the code anyway; see sameNetworkExempt). Misses still count.
        // Same answer on a socket in its miss cooldown, so every "Game not found" below is a recorded miss.
        // A malformed code matches no room: same "Game not found" answer, counted as a miss
        const target = isRoomCode(gameCode) ? roomManager.getRoom(gameCode) : undefined;
        if ((missCooldown() || joinMisses.locked(ip)) && !roomManager.canRejoin(gameCode, username, data.rejoinToken) && !sameNetworkExempt(target)) {
          if (!target) recordMiss();
          socket.emit("room-of-game", { success: false, message: "Too many attempts" });
          return;
        }
        if (!target) {
          recordMiss();
          socket.emit("room-of-game", { success: false, message: "Game not found" });
          return;
        }
        // Same room under another username: the socket's own player frees its slot
        const replacing = current && current.room.gameCode === gameCode ? current.player.username : undefined;
        const result = roomManager.joinRoom(gameCode, username, socket.id, data.rejoinToken, replacing);
        if (result.success && result.room) {
          const player = roomManager.getPlayer(gameCode, username)!;
          leavePrevious();
          socket.join(gameCode);
          socket.data.gameCode = gameCode;
          socket.data.username = username;
          // rejoinToken and the player's own planted mark go only to this socket
          socket.emit("room-of-game", {
            success: true, room: roomManager.safeRoomData(result.room), rounds: result.room.rounds,
            rejoinToken: player.rejoinToken, hasPlantedPhoto: !!player.hasPlantedPhoto,
          });
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
        socket.emit("room-of-game", { success: true, room: roomManager.safeRoomData(room), rejoinToken: room.players[0].rejoinToken, hasPlantedPhoto: false });
      }
    } catch (e) { console.error("join-create-game error:", e); }
  });

  socket.on("disconnect", () => {
    try {
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;

      const room = roomManager.getRoom(gameCode);
      if (!room) return;

      releaseHoldOf(room, socket.id);

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
      // Lobby: after DISCONNECT_GRACE they are shown as gone and a gone host hands over; mid-game: pause if fewer than 2
      // players remain connected
      gameEngine.onConnectionChange(room);
    } catch (e) { console.error("disconnect error:", e); }
  });

  // Explicit leave — player pressed the leave button
  socket.on("leave-room", () => {
    try {
      if (!gameEvents.take("leave-room")) return;
      // A socket replaced by a rejoin only detaches itself; the live player stays
      leaveCurrentRoom(socket);
    } catch (e) { console.error("leave-room error:", e); }
  });

  // Payload gameCode is ignored: host-only, applies to the host's own room
  socket.on("set-rounds", (data: { rounds: number }) => {
    try {
      if (!gameEvents.take("set-rounds")) return;
      const s = session(socket);
      if (!s || !s.player.isHost || s.room.started) return;
      if (!isAllowedRounds(data?.rounds) || data.rounds === s.room.rounds) return;
      if (roomManager.setRounds(s.room.gameCode, data.rounds)) io.to(s.room.gameCode).emit("rounds-updated", data.rounds);
    } catch (e) { console.error("set-rounds error:", e); }
  });

  socket.on("start-game", () => {
    try {
      if (!gameEvents.take("start-game")) return;
      const s = session(socket);
      if (!s || !s.player.isHost || s.room.started) return;
      gameEngine.startGame(s.room);
    } catch (e) { console.error("start-game error:", e); }
  });

  socket.on("im-ready", () => {
    try {
      if (!gameEvents.take("im-ready")) return;
      const s = session(socket);
      if (!s) return;
      gameEngine.markReady(s.room, s.player);
    } catch (e) { console.error("im-ready error:", e); }
  });

  // ── In-game ────────────────────────────────────────

  // Only the current photo owner, and only with a path this player uploaded in this room
  socket.on("photo-sent", (data: { photo: string }) => {
    try {
      if (!gameEvents.take("photo-sent")) return;
      const s = session(socket);
      if (!s || !isOwnUpload(data?.photo, s.room, s.player)) return;
      gameEngine.onPhotoReceived(s.room, data.photo, s.player.username);
    } catch (e) { console.error("photo-sent error:", e); }
  });

  // The current photo owner has no photo to send (no gallery access, no photos, upload failed): skip now.
  // `{ round, attempt }` of the your-turn being answered; the engine accepts it only from the awaited owner, for the
  // current photo request
  socket.on("photo-unavailable", (data: PhotoUnavailableData) => {
    try {
      if (!gameEvents.take("photo-unavailable")) return;
      const s = session(socket);
      if (!s || !Number.isInteger(data?.round) || !Number.isInteger(data?.attempt)) return;
      gameEngine.onPhotoUnavailable(s.room, s.player.username, data.round, data.attempt);
    } catch (e) { console.error("photo-unavailable error:", e); }
  });

  // The app sends a pick on every tap: token bucket per socket (lives and dies with it), excess dropped silently
  const answerBucket = { tokens: ANSWER_BURST, at: Date.now() };
  socket.on("submit-answer", (data: { guess: string }) => {
    try {
      const now = Date.now();
      answerBucket.tokens = Math.min(ANSWER_BURST, answerBucket.tokens + ((now - answerBucket.at) / 1000) * ANSWER_RATE_PER_S);
      answerBucket.at = now;
      if (answerBucket.tokens < 1) return;
      answerBucket.tokens--;
      const s = session(socket);
      if (!s) return;
      const guess = typeof data?.guess === "string" && data.guess.length <= MAX_USERNAME_LENGTH ? data.guess : "";
      gameEngine.recordAnswer(s.room, s.player.username, guess);
    } catch (e) { console.error("submit-answer error:", e); }
  });

  // ── Hold ───────────────────────────────────────────

  // Only the photo owner, a few holds per round (GameEngine); hold-start also rate-limited per socket
  const holdBucket = createTokenBucket(HOLD_START_BURST, HOLD_START_RATE_PER_S);
  socket.on("hold-start", () => {
    try {
      if (!holdBucket.take()) return;
      const s = session(socket);
      if (!s) return;
      if (gameEngine.handleHold(s.room, s.player.socketId)) {
        io.to(s.room.gameCode).emit("hold-start");
      }
    } catch (e) { console.error("hold-start error:", e); }
  });

  socket.on("hold-end", () => {
    try {
      // Only a real release spends a token: there are never more than holds accepted (hold-start is limited more
      // tightly), so a release always gets through, and a flood from a socket that holds nothing stops here
      const s = session(socket);
      if (!s || !isHolding(s.room, socket.id) || !gameEvents.take("hold-end")) return;
      if (gameEngine.handleRelease(s.room, s.player.socketId)) {
        // hold-resume is emitted by doRelease in GameEngine
        // hold-end tells clients the hold is over
        io.to(s.room.gameCode).emit("hold-end");
      }
    } catch (e) { console.error("hold-end error:", e); }
  });

  // ── Social ─────────────────────────────────────────

  // Social events: payload gameCode/username are ignored, the session decides room and sender

  // Only the emojis the app offers (ALLOWED_EMOJIS), token bucket per socket; anything else is dropped silently
  const emojiBucket = createTokenBucket(EMOJI_BURST, EMOJI_RATE_PER_S);
  socket.on("emoji-reaction", (data: { emoji: string }) => {
    try {
      const s = session(socket);
      const emoji = data?.emoji;
      if (!s || typeof emoji !== "string" || !ALLOWED_EMOJIS.has(emoji) || !emojiBucket.take()) return;
      io.to(s.room.gameCode).emit("emoji-reaction", { username: s.player.username, emoji });
    } catch (e) { console.error("emoji error:", e); }
  });

  socket.on("plant-photo", (data: { photoUrl: string }) => {
    try {
      if (!gameEvents.take("plant-photo")) return;
      const s = session(socket);
      const photoUrl = data?.photoUrl;
      if (!s || !isOwnUpload(photoUrl, s.room, s.player)) return;
      const { room, player } = s;
      // Accept planted photos until the first round actually starts playing (same rule as POST /upload)
      if (!acceptsPlantedPhoto(room)) return;
      // Replaces an earlier planted photo of this player; the mark only goes back to them (room-of-game)
      uploadStore.replacePlanted(player.plantedPhoto, photoUrl); // the replaced planted photo is deleted
      player.plantedPhoto = photoUrl;
      player.hasPlantedPhoto = true;
      gameEngine.onLatePlantedPhoto(room); // retry sent after the planted rounds were drawn
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

  // Host kicks a player by username (socket ids are never sent to clients); the host can't kick itself
  socket.on("remove-player", (data: { username: string }) => {
    try {
      if (!gameEvents.take("remove-player")) return;
      const s = session(socket);
      if (!s || !s.player.isHost || typeof data?.username !== "string" || data.username === s.player.username) return;
      const { room } = s;
      const removed = roomManager.removePlayerByUsername(room.gameCode, data.username);
      if (removed) {
        // Here, not on its disconnect: the eviction below clears the socket's session, so that handler skips it
        releaseHoldOf(room, removed.socketId);
        io.to(room.gameCode).emit("player-removed", roomManager.publicPlayer(removed, room));
        // The kicked player's current socket and any other socket still bound to them in this room
        const target = io.sockets.sockets.get(removed.socketId);
        if (target) evictSocket(target, room.gameCode);
        socketsOf(room.gameCode, removed.username).forEach((old) => evictSocket(old, room.gameCode));
        gameEngine.checkReady(room);
        gameEngine.onConnectionChange(room);
      }
    } catch (e) { console.error("remove-player error:", e); }
  });

  // ── QA telemetry (dev/QA only) ─────────────────────

  if (qaTelemetry) {
    const qaAckBucket = createTokenBucket(QA_ACK_BURST, QA_ACK_RATE_PER_S);
    socket.on("qa-ack", (data: unknown) => {
      try {
        const s = session(socket);
        if (!s || !isQaAck(data) || !qaAckBucket.take()) return;
        const { phase, round, at, handledAt } = data;
        qaTelemetry.record({
          gameCode: s.room.gameCode, username: s.player.username, phase, round, at, handledAt, receivedAt: Date.now(),
          serverAt: gameEngine.phaseEmittedAt(s.room, phase, round),
        });
      } catch (e) { console.error("qa-ack error:", e); }
    });
  }
});
