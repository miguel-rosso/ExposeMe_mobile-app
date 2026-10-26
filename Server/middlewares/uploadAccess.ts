import { NextFunction, Request, Response } from "express";
import { Player, Room } from "../models/interfaces";
import { uploadStore } from "./uploadStore";
import { uploadRejectionLimit } from "./rateLimit";
import { normalizeRoomCode } from "../managers/roomCode";

// ── Room-member access to /upload and /temp ──
// Both need the player's session credential from join-create-game: header `X-Game-Code: <room code>` plus
// `Authorization: Bearer <rejoinToken>`. Missing/malformed → 401, unknown room or wrong token → 403.

export const GAME_CODE_HEADER = "x-game-code";
/** Photos a room may hold at once (a 20-round game + planted photos needs far fewer). */
export const MAX_UPLOADS_PER_ROOM = 100;

export interface Member {
  room: Room;
  player: Player;
}

/** What /upload and /temp need from the room manager (set by routes/socketRoutes at startup). */
export interface RoomDirectory {
  getRoom(gameCode: string): Room | undefined;
  authenticate(gameCode: string, token: string): Member | null;
}

let rooms: RoomDirectory | null = null;

export function setUploadRooms(directory: RoomDirectory | null): void {
  rooms = directory;
}

const MAX_CREDENTIAL_LENGTH = 128;
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+)$/;

/** Credentials from the request headers, or null if missing/malformed. Never logged. */
function readCredentials(req: Request): { gameCode: string; token: string } | null {
  const code = req.get(GAME_CODE_HEADER);
  const auth = req.get("authorization");
  if (!code || !auth || code.length > MAX_CREDENTIAL_LENGTH || auth.length > MAX_CREDENTIAL_LENGTH) return null;
  const m = BEARER_RE.exec(auth);
  if (!m) return null;
  return { gameCode: normalizeRoomCode(code), token: m[1] };
}

/** The member these credentials belong to, or the status to refuse them with (401 missing/malformed, 403 wrong). */
function authenticateRequest(req: Request): Member | 401 | 403 {
  const creds = readCredentials(req);
  if (!creds) return 401;
  return rooms?.authenticate(creds.gameCode, creds.token) ?? 403;
}

/** 401 without valid-looking credentials, 403 if they don't match a current room member; else res.locals.member. */
export function requireRoomMember(req: Request, res: Response, next: NextFunction) {
  const member = authenticateRequest(req);
  if (member === 401) return void res.status(401).json({ error: "Unauthorized" });
  if (member === 403) return void res.status(403).json({ error: "Forbidden" });
  res.locals.member = member;
  next();
}

/**
 * requireRoomMember for POST /upload: rejections are rate limited per IP (429 instead of 401 once over the limit;
 * wrong credentials always get 403, see createRejectionLimiter), members aren't.
 */
export function requireUploadMember(req: Request, res: Response, next: NextFunction) {
  const member = authenticateRequest(req);
  if (member === 401 || member === 403) return uploadRejectionLimit.reject(req, res, member);
  res.locals.member = member;
  next();
}

/**
 * Planted photos (upload + plant-photo) are accepted until the first round is actually played: in the lobby, the
 * ready phase and while round 1's photo is still awaited (also after skips, which don't advance `room.round`).
 */
export function acceptsPlantedPhoto(room: Room): boolean {
  return room.phase === null || (room.phase === "waiting-photo" && room.round === 0);
}

/**
 * A member may upload a planted photo (acceptsPlantedPhoto) or the photo the server is awaiting from them. Records
 * the room's release epoch so the upload is dropped if the game ends (or the room closes) while the image is being
 * processed.
 */
export function requireUploadAllowed(_req: Request, res: Response, next: NextFunction) {
  const { room, player } = res.locals.member as Member;
  const awaited = room.phase === "waiting-photo" && room.currentPlayer?.username === player.username;
  if (!acceptsPlantedPhoto(room) && !awaited) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (uploadStore.countFor(room.gameCode) >= MAX_UPLOADS_PER_ROOM) {
    res.status(429).json({ error: "Too many uploads" });
    return;
  }
  res.locals.uploadEpoch = uploadStore.epoch(room.gameCode);
  // Turn photo or planted photo: a new upload only supersedes older unused ones of the same kind (uploadStore)
  res.locals.uploadKind = awaited ? "turn" : "planted";
  next();
}

/** True if the member authorized for this request is still in the same room (not deleted, not left). */
export function stillMember(member: Member): boolean {
  const room = rooms?.getRoom(member.room.gameCode);
  return room === member.room && room.players.includes(member.player);
}

/** GET /temp/:name — only a photo of the member's own room; anything else is a plain 404. */
export function requireRoomUpload(req: Request, res: Response, next: NextFunction) {
  const { room } = res.locals.member as Member;
  const record = typeof req.params.name === "string" ? uploadStore.get(req.params.name) : undefined;
  if (!record || record.gameCode !== room.gameCode) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
