import { Socket } from "socket.io";
import { io } from "../app";
import { isAllowedRounds, RoomManager } from "../managers/RoomManager";
import { GameEngine } from "../managers/GameEngine";
import { isValidUsername, MAX_USERNAME_LENGTH } from "../managers/playerName";
import { maskOffensiveWords } from "../managers/chatFilter";
import { isRoomCode, normalizeRoomCode } from "../managers/roomCode";
import { acceptsPlantedPhoto, setUploadRooms } from "../middlewares/uploadAccess";
import { UploadRecord, uploadNameOf, uploadStore } from "../middlewares/uploadStore";
import { createSlidingWindow } from "../middlewares/rateLimit";
import {
  ALLOWED_EMOJIS, CHAT_MESSAGE_LIMIT, createConnectionCounter, createEventLimiter, createJoinMissGuard, createSocketWindowLimit,
  createTokenBucket, EMOJI_BURST, EMOJI_RATE_PER_S, GAME_EVENT_LIMITS, handshakeKey,
  HOLD_START_BURST, HOLD_START_RATE_PER_S, JOIN_EXEMPT_MAX, JOIN_MISS_GLOBAL_MAX, JOIN_MISS_HARD_FACTOR, JOIN_MISS_MAX,
  JOIN_ATTEMPT_LIMIT, JOIN_MISS_PREFIX_MAX, JOIN_MISS_PRESSURE_MAX, JOIN_MISS_SOCKET_INTERVAL_MS, JOIN_MISS_WINDOW_MS,
  MAX_CONNECTIONS_PER_IP,
} from "../managers/socketGuards";
import { createChatLog } from "../managers/chatLog";
import { contentKey, parseReport, ReportContentAck, ReportContentData, resolveReport } from "../managers/contentReports";
import { createReportLedger } from "../managers/reportLedger";
import { reportStore } from "../managers/reportStore";
import { createQaTelemetry, isQaAck, isQaPhotoShown, QA_ACK_BURST, QA_ACK_RATE_PER_S } from "../managers/qaTelemetry";
import { JoinCreateGameData, PhotoUnavailableData, Player, Room, RoomOfGameResponse, StartGameAck } from "../models/interfaces";

const roomManager = new RoomManager();
const gameEngine = new GameEngine(io, roomManager);
// POST /upload and GET /temp authenticate room members against these rooms
setUploadRooms(roomManager);
/** Exported for test teardown (roomManager.clear()). */
export { roomManager };

const MAX_CHAT_LENGTH = 100;
// Per-socket sliding windows (see managers/socketGuards): join-create-game attempts, chat messages
const joinAttempts = createSocketWindowLimit(JOIN_ATTEMPT_LIMIT);
const chatMessages = createSocketWindowLimit(CHAT_MESSAGE_LIMIT);
// Each room's recent chat, so a reported message can be checked against what was really sent (EXP-423)
const chatLog = createChatLog();
// Each room game's reports: one per player and content, and a few photo copies per game (EXP-423)
const reportLedger = createReportLedger();
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
// Dev/QA only (QA_TELEMETRY=1): records when each device rendered a phase and showed the round photo; null in
// production (no qa-ack / qa-photo-shown handler)
const qaTelemetry = createQaTelemetry();
/** Exported for tests: open connections and join misses per IP key, join attempts and chat messages per socket. */
export { chatMessages, connections, joinAttempts, joinMisses };

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

/** Store record of a /upload path that this player uploaded in this room (and that hasn't been deleted). */
function ownUploadRecord(value: unknown, room: Room, player: Player): UploadRecord | undefined {
  if (!isUploadPath(value)) return undefined;
  const record = uploadStore.get(value.slice("/temp/".length));
  return record?.gameCode === room.gameCode && record.username === player.username ? record : undefined;
}

/** A /upload path that this player uploaded in this room (and that hasn't been deleted). */
function isOwnUpload(value: unknown, room: Room, player: Player): value is string {
  return ownUploadRecord(value, room, player) !== undefined;
}

/**
 * An own upload made as the awaited owner's turn photo for the photo being awaited now: not a planted photo (lobby
 * pick or plant-photo) and not one stored at an earlier round, i.e. already shown (rounds only advance on show).
 */
function isCurrentTurnUpload(value: unknown, room: Room, player: Player): value is string {
  const record = ownUploadRecord(value, room, player);
  return record?.kind === "turn" && !record.planted && record.round === room.round;
}

// ── Planted photo ──

/**
 * Why plant-photo was refused: the socket is in no room, the payload is no upload path, the game no longer takes
 * planted photos, or the path is no upload of this player in this room (expired, deleted or never theirs: a single
 * answer, so it never tells whether another player's photo exists).
 */
type PlantRefusal = "not-in-room" | "invalid" | "too-late" | "photo-unavailable";
/** plant-photo's acknowledgement. */
type PlantPhotoAck = { ok: true } | { ok: false; reason: PlantRefusal };

/** Plants `photoUrl` as the session player's planted photo (replacing an earlier one), or says why not. */
function plantPhoto(socket: Socket, photoUrl: unknown): PlantPhotoAck {
  const s = session(socket);
  if (!s) return { ok: false, reason: "not-in-room" };
  if (!isUploadPath(photoUrl)) return { ok: false, reason: "invalid" };
  const { room, player } = s;
  // Accept planted photos until the first round actually starts playing (same rule as POST /upload). Not while
  // this player's planted photo is the one awaited now: a re-send whose ack was lost would show the image twice
  if (!acceptsPlantedPhoto(room) || gameEngine.isPlanterOfCurrentWait(room, player)) {
    return { ok: false, reason: "too-late" };
  }
  // Any own upload, a turn-kind one too: round 1's owner may plant while their turn is awaited (POST /upload then
  // stores it as a turn photo); once planted, photo-sent no longer takes it
  if (!isOwnUpload(photoUrl, room, player)) return { ok: false, reason: "photo-unavailable" };
  // Replaces an earlier planted photo of this player; the mark only goes back to them (room-of-game)
  uploadStore.replacePlanted(player.plantedPhoto, photoUrl); // the replaced planted photo is deleted
  player.plantedPhoto = photoUrl;
  player.hasPlantedPhoto = true;
  gameEngine.onLatePlantedPhoto(room); // retry sent after the planted rounds were drawn
  console.log(`[${room.gameCode}] Planted photo received from ${player.username}`);
  return { ok: true };
}

// ── Reports ──

/** The upload file of a round photo's `/temp/<name>` path, while it is still stored (for the report's photo copy). */
function uploadFileOf(photo: string): string | null {
  const name = uploadNameOf(photo);
  return (name && uploadStore.get(name)?.file) || null;
}

/**
 * The reported round photo kept for review right now, before the game can delete its upload: its name in the reports'
 * photos, or null when it is gone already, the game already keeps its share of other photos, or the disk refused it
 * (EACCES, ENOSPC…: only the error code is logged). The report is stored either way. Otherwise not logged: a line
 * would tell when the room reported something.
 */
function keepReportedPhoto(room: Room, photo: string): string | null {
  if (!reportLedger.mayKeepPhoto(room, photo)) return null;
  const upload = uploadFileOf(photo);
  let kept: string | null = null;
  try {
    kept = upload ? reportStore.keepPhoto(upload) : null;
  } catch (err) {
    console.error("Reported photo not kept:", (err as NodeJS.ErrnoException)?.code ?? "unknown error");
    return null;
  }
  if (kept) reportLedger.photoKept(room, photo);
  return kept;
}

/**
 * Files the session player's report about content of another player in their own room (EXP-423): a round photo they
 * were shown, or a message still in the room's chat log that was sent while they were there. Stored (and the webhook
 * notified) without waiting for it; the photo is kept at once (keepReportedPhoto). A second report of the same
 * content by the same player in a game is acknowledged the same, and not stored again. Never logged: the room's log
 * would pair it with the round's "photo from <owner>" line.
 */
function reportContent(socket: Socket, data: ReportContentData): ReportContentAck {
  const s = session(socket);
  if (!s) return { ok: false, reason: "not-in-room" };
  const report = parseReport(data);
  if (!report) return { ok: false, reason: "invalid" };
  const { room, player } = s;
  const content = resolveReport(report, player, {
    shownPhoto: (round) => gameEngine.shownPhoto(room, round),
    heardByReporter: (author, text) => chatLog.heardBy(room, author, text, player),
  });
  if (!content) return { ok: false, reason: "not-found" };
  const key = contentKey(content);
  if (reportLedger.alreadyReported(room, player, key)) return { ok: true };
  const { round, reported, text, photo } = content;
  void reportStore.save(
    {
      time: new Date().toISOString(), roomCode: room.gameCode, round, reporter: player.username, reported,
      kind: report.kind, reason: report.reason, text,
    },
    photo ? keepReportedPhoto(room, photo) : null,
  );
  // Only once queued: a report that failed before (no ack) is stored when the app sends it again
  reportLedger.recordReport(room, player, key);
  return { ok: true };
}

// ── Starting a game ──

/** Starts the game of the session's room if the sender is its host and no game is running, or says why not. */
function startGame(socket: Socket): StartGameAck {
  const s = session(socket);
  if (!s) return { ok: false, reason: "not-in-room" };
  if (!s.player.isHost) return { ok: false, reason: "not-host" };
  if (s.room.started) return { ok: false, reason: "already-started" };
  return gameEngine.startGame(s.room);
}

/**
 * Room and player bound to this socket by a successful join-create-game.
 * Identity always comes from here: payloads carry none, and a gameCode/username field in one is ignored.
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
 * The photo owner on `socketId` is going away (leave, disconnect): end their hold of the scores screen now
 * (hold-resume + hold-end) instead of leaving everyone frozen until the hold budget runs out.
 */
function releaseHoldOf(room: Room, socketId: string): void {
  if (isHolding(room, socketId)) gameEngine.forceRelease(room);
}

/**
 * Drop a room binding of this socket, as an explicit leave. If `owned` (the socket still is that player's
 * current socket) the player is removed (a hold of theirs released), host handed over and the room notified; a socket
 * replaced by a rejoin only detaches. Always leaves the socket.io room. Does not touch socket.data.
 */
function leaveBinding(socket: Socket, gameCode: string, username: string, owned: boolean): void {
  const room = roomManager.getRoom(gameCode);
  if (owned && room) gameEngine.removePlayer(room, username, "left");
  socket.leave(gameCode); // after the removal: the leaver hears it too
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

/** The seat a leave-room from a socket bound to no room gives up (see leaveSeat). */
interface LeaveSeatData {
  gameCode: string;
  username: string;
  rejoinToken: string;
}

function isLeaveSeat(value: unknown): value is LeaveSeatData {
  const seat = value as Partial<Record<keyof LeaveSeatData, unknown>> | null | undefined;
  return typeof seat?.gameCode === "string" && typeof seat.username === "string" && typeof seat.rejoinToken === "string";
}

/**
 * Leave from a socket bound to no room, naming the seat to give up: the app leaving right after its reconnection
 * (EXP-387). Only with that player's rejoin token (checked as a rejoin checks it) is the player removed, as a leave;
 * the seat is never bound to this socket first, so a paused game is not resumed one round trip before it ends. Any
 * socket still bound to that player (an old connection the server hasn't seen drop yet) is cut off. The sender is told
 * nothing either way: whether the room, the player or the token exist, the ack is the same.
 */
function leaveSeat(seat: unknown): void {
  if (!isLeaveSeat(seat)) return;
  const { gameCode, username, rejoinToken } = seat;
  const room = roomManager.getRoom(gameCode);
  if (!room || !roomManager.canRejoin(gameCode, username, rejoinToken)) return;
  gameEngine.removePlayer(room, username, "left", (left) => {
    socketsOf(gameCode, left.username).forEach((old) => evictSocket(old, gameCode));
  });
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
      /** The join is refused: the socket keeps the binding it had (if any). */
      const refuse = (message: string | undefined): void => {
        socket.emit("room-of-game", { success: false, message } satisfies RoomOfGameResponse);
      };

      if (!joinAttempts.take(socket.id)) return refuse("Too many attempts");

      const username = data?.username;
      const rawCode = data?.gameCode;
      // No invisible characters; lookalikes of a player's name are refused by RoomManager.joinRoom (EXP-032)
      if (!isValidUsername(username)) return refuse("Invalid username");
      if (rawCode != null && typeof rawCode !== "string") {
        recordMiss();
        return refuse("Game not found");
      }
      // No code (null/"") creates a room; any other string is a code to join, typed in any case
      const gameCode = rawCode ? normalizeRoomCode(rawCode) : null;

      /** The join succeeded: the public room, plus the player's rejoinToken and own planted mark (only to this socket). */
      const replyJoined = (room: Room, player: Player): void => {
        socket.emit("room-of-game", {
          success: true, room: roomManager.safeRoomData(room), rejoinToken: player.rejoinToken, hasPlantedPhoto: !!player.hasPlantedPhoto,
        } satisfies RoomOfGameResponse);
      };

      // One socket = one player in one room. The same live socket re-sending join for the room and username
      // it already owns (WaitingRoom effect re-run, duplicate join) is a no-op. Reconnects and "Play again"
      // arrive on a new socket and go through the normal rejoin (token) path below.
      const current = session(socket);
      if (current && gameCode === current.room.gameCode && username === current.player.username) {
        replyJoined(current.room, current.player);
        // Game in progress: the app asks again from the game screen, which missed the rejoin snapshot
        gameEngine.resendState(current.room, current.player);
        return;
      }

      // Any other join first tries the new binding; only on success is the previous one left
      // (player removed, host handed over). A failed join keeps the socket where it was.
      const prevCode: string | null = socket.data.gameCode ?? null;
      const prevUsername: string | null = socket.data.username ?? null;
      /** Leave the previous binding (unless it is this same one), then bind this socket to `username` in `code`. */
      const bindTo = (code: string): void => {
        if (prevCode && prevUsername && !(prevCode === code && prevUsername === username)) {
          leaveBinding(socket, prevCode, prevUsername, current !== null);
        }
        socket.join(code);
        socket.data.gameCode = code;
        socket.data.username = username;
      };

      if (gameCode === null) {
        if (roomManager.isAtCapacity()) return refuse("Server is busy");
        const room = roomManager.createRoom(username, socket.id);
        bindTo(room.gameCode);
        replyJoined(room, room.players[0]);
        return;
      }

      // This IP guessed too many unknown codes: no answer reveals whether this code exists, unless the sender
      // proves it is a player of that room (rejoin with its token) or a connected player of the room is on the
      // same IP (same network: they know the code anyway; see sameNetworkExempt). Misses still count.
      // Same answer on a socket in its miss cooldown, so every "Game not found" below is a recorded miss.
      // A malformed code matches no room: same "Game not found" answer, counted as a miss
      const target = isRoomCode(gameCode) ? roomManager.getRoom(gameCode) : undefined;
      if ((missCooldown() || joinMisses.locked(ip)) && !roomManager.canRejoin(gameCode, username, data.rejoinToken) && !sameNetworkExempt(target)) {
        if (!target) recordMiss();
        return refuse("Too many attempts");
      }
      if (!target) {
        recordMiss();
        return refuse("Game not found");
      }
      // Same room under another username: the socket's own player frees its slot
      const replacing = current && current.room.gameCode === gameCode ? current.player.username : undefined;
      const result = roomManager.joinRoom(gameCode, username, socket.id, data.rejoinToken, replacing);
      if (!result.success || !result.room) return refuse(result.message);

      const player = roomManager.getPlayer(gameCode, username)!;
      bindTo(gameCode);
      replyJoined(result.room, player);
      // Only broadcast player-joined for new players, not rejoins
      if (!result.rejoin) socket.broadcast.to(gameCode).emit("player-joined", roomManager.publicPlayer(player));
      // A rejoin replaces the player's previous socket(s): they must not keep receiving the room's events
      if (result.rejoin) socketsOf(gameCode, username, socket.id).forEach((old) => evictSocket(old, gameCode));
      console.log(`[${gameCode}] ${username} ${result.rejoin ? "rejoined" : "joined"}`);
      // Reconnect: snapshot of the current game to this socket, and resume a paused game
      if (result.rejoin) gameEngine.onPlayerRejoined(result.room, player);
    } catch (e) { console.error("join-create-game error:", e); }
  });

  socket.on("disconnect", () => {
    try {
      // Before any early return: the socket's limit state dies with it, in a room or not
      joinAttempts.forget(socket.id);
      chatMessages.forget(socket.id);
      const { gameCode, username } = socket.data;
      if (!gameCode || !username) return;

      const room = roomManager.getRoom(gameCode);
      if (!room) return;

      releaseHoldOf(room, socket.id);

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

  // Explicit leave — player pressed the leave button. A bound socket sends no payload and leaves its binding; one bound
  // to no room may name the seat it gives up (leaveSeat). Acked once handled: the app closes the socket only then, since
  // an event that socket.io dispatches after the disconnect is dropped (the leave would look like a lost connection)
  socket.on("leave-room", (...args: unknown[]) => {
    try {
      if (!gameEvents.take("leave-room")) return;
      const ack = args[args.length - 1];
      // A socket replaced by a rejoin only detaches itself; the live player stays
      if (socket.data.gameCode) leaveCurrentRoom(socket);
      else leaveSeat(args[0]);
      if (typeof ack === "function") ack();
    } catch (e) { console.error("leave-room error:", e); }
  });

  // Host-only, applies to the host's own room
  socket.on("set-rounds", (data: { rounds: number }) => {
    try {
      if (!gameEvents.take("set-rounds")) return;
      const s = session(socket);
      if (!s || !s.player.isHost || s.room.started) return;
      if (!isAllowedRounds(data?.rounds) || data.rounds === s.room.rounds) return;
      if (roomManager.setRounds(s.room.gameCode, data.rounds)) io.to(s.room.gameCode).emit("rounds-updated", data.rounds);
    } catch (e) { console.error("set-rounds error:", e); }
  });

  // Acked once handled (after game-started, when it starts), so the host's button can say why nothing happened.
  // Not acked when dropped by the rate limit, like every limited event: the app gives up waiting on its own
  socket.on("start-game", (ack?: unknown) => {
    try {
      if (!gameEvents.take("start-game")) return;
      const answer = startGame(socket);
      if (typeof ack === "function") ack(answer);
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

  // Only the current photo owner, and only with the turn photo they uploaded for this round in this room
  socket.on("photo-sent", (data: { photo: string }) => {
    try {
      if (!gameEvents.take("photo-sent")) return;
      const s = session(socket);
      if (!s || !isCurrentTurnUpload(data?.photo, s.room, s.player)) return;
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

  // The app sends a pick on every tap
  socket.on("submit-answer", (data: { guess: string }) => {
    try {
      if (!gameEvents.take("submit-answer")) return;
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
      gameEngine.handleHold(s.room, s.player.socketId); // an accepted hold tells the room (hold-start)
    } catch (e) { console.error("hold-start error:", e); }
  });

  socket.on("hold-end", () => {
    try {
      // Only a real release spends a token: there are never more than holds accepted (hold-start is limited more
      // tightly), so a release always gets through, and a flood from a socket that holds nothing stops here
      const s = session(socket);
      if (!s || !isHolding(s.room, socket.id) || !gameEvents.take("hold-end")) return;
      gameEngine.handleRelease(s.room, s.player.socketId); // hold-resume, then hold-end (with holdsLeft) to the room
    } catch (e) { console.error("hold-end error:", e); }
  });

  // ── Social ─────────────────────────────────────────

  // Social events: the session decides room and sender

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

  // Acked with plantPhoto's answer; not acked when dropped by the rate limit (the app's ack timeout covers that)
  socket.on("plant-photo", (data: { photoUrl: string }, ack?: unknown) => {
    try {
      if (!gameEvents.take("plant-photo")) return;
      const answer = plantPhoto(socket, data?.photoUrl);
      if (typeof ack === "function") ack(answer);
    } catch (e) { console.error("plant-photo error:", e); }
  });

  // Acked with the text the room got (offensive words masked), so the sender shows exactly that; not acked when dropped
  socket.on("chat-message", (data: { message: string }, ack?: unknown) => {
    try {
      const s = session(socket);
      const message = data?.message;
      if (!s || typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_LENGTH) return;
      if (!chatMessages.take(socket.id)) return;
      const relayed = maskOffensiveWords(message);
      socket.broadcast.to(s.room.gameCode).emit("chat-message", { username: s.player.username, message: relayed });
      // The text exactly as the room got it: a report names a bubble by its author and that text (EXP-423)
      chatLog.record(s.room, s.player.username, relayed);
      if (typeof ack === "function") ack({ message: relayed });
    } catch (e) { console.error("chat error:", e); }
  });

  // Host kicks a player by username (socket ids are never sent to clients); the host can't kick itself. In the lobby,
  // between games and during a game alike (EXP-425): mid-game the kicked player goes as on leave-room (a hold of theirs
  // released, still an option of the round in play, the game paused or ended if too few are left)
  socket.on("remove-player", (data: { username: string }) => {
    try {
      if (!gameEvents.take("remove-player")) return;
      const s = session(socket);
      if (!s || !s.player.isHost) return;
      if (typeof data?.username !== "string" || data.username === s.player.username) return;
      const { room } = s;
      // Cut off the kicked player's token, current socket and any other socket still bound to them in this room: an app
      // that was offline and missed player-removed is told when it rejoins with that token
      gameEngine.removePlayer(room, data.username, "kicked", (kicked) => {
        roomManager.revokeRejoinToken(room, kicked.rejoinToken);
        const target = io.sockets.sockets.get(kicked.socketId);
        if (target) evictSocket(target, room.gameCode);
        socketsOf(room.gameCode, kicked.username).forEach((old) => evictSocket(old, room.gameCode));
      });
    } catch (e) { console.error("remove-player error:", e); }
  });

  // ── Reports ────────────────────────────────────────

  // A round photo or another player's chat message, reported with a reason (EXP-423). Only the reported content comes
  // in the payload (reporter and room from the session). Acked with reportContent's answer once handled; not acked
  // when dropped by the rate limit (the app's ack timeout covers that)
  socket.on("report-content", (data: Partial<ReportContentData> | undefined, ack?: unknown) => {
    try {
      if (!gameEvents.take("report-content")) return;
      const answer = reportContent(socket, {
        kind: data?.kind, reason: data?.reason, round: data?.round, author: data?.author, text: data?.text,
      });
      if (typeof ack === "function") ack(answer);
    } catch (e) { console.error("report-content error:", e); }
  });

  // ── QA telemetry (dev/QA only) ─────────────────────

  if (qaTelemetry) {
    const qaAckBucket = createTokenBucket(QA_ACK_BURST, QA_ACK_RATE_PER_S);
    socket.on("qa-ack", (data: unknown) => {
      try {
        const s = session(socket);
        if (!s || !isQaAck(data) || !qaAckBucket.take()) return;
        const { phase, round, at, platform, handledAt } = data;
        qaTelemetry.record({
          gameCode: s.room.gameCode, username: s.player.username, phase, round, at, platform, handledAt,
          receivedAt: Date.now(), serverAt: gameEngine.phaseEmittedAt(s.room, phase, round),
        });
      } catch (e) { console.error("qa-ack error:", e); }
    });
    socket.on("qa-photo-shown", (data: unknown) => {
      try {
        const s = session(socket);
        if (!s || !isQaPhotoShown(data) || !qaAckBucket.take()) return;
        const { phase, round, at, platform, failed } = data;
        qaTelemetry.record({
          kind: "photo-shown", gameCode: s.room.gameCode, username: s.player.username, phase, round, at, platform,
          failed, receivedAt: Date.now(),
        });
      } catch (e) { console.error("qa-photo-shown error:", e); }
    });
  }
});
