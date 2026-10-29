import type { Socket } from "socket.io-client";
import { emitWhileConnected } from "./socketEmit";

/** How long plant-photo waits for the server's ack before counting the photo as not sent. */
export const PLANT_ACK_TIMEOUT_MS = 5000;

/**
 * Why the server refused plant-photo (see Server/GAME_FLOW.md, "Planting"): the socket is in no room yet (the rejoin
 * plants it again), the payload is no upload path, the game no longer takes planted photos, or the server doesn't
 * have that upload of mine (e.g. deleted as unclaimed after UPLOAD_PLANT_CLAIM_MS: uploading it again helps).
 */
export type PlantRefusal = "not-in-room" | "invalid" | "too-late" | "photo-unavailable";
export type PlantPhotoAck = { ok: true } | { ok: false; reason: PlantRefusal };

export type PlantingSocket = Pick<Socket, "connected" | "emit" | "on" | "off">;

const isPlantPhotoAck = (answer: unknown): answer is PlantPhotoAck =>
  typeof answer === "object" && answer !== null && typeof (answer as { ok?: unknown }).ok === "boolean";

export interface SendPlantPhotoOptions {
  timeoutMs?: number;
  /** The ack arrived after `timeoutMs` (a slow server on a live connection): the promise already resolved null. */
  onLateAck?: (answer: PlantPhotoAck) => void;
}

/**
 * Sends plant-photo and resolves with the server's ack, or null when there is none: not connected (never emitted,
 * see emitWhileConnected), the connection dropped while waiting, or no answer within `timeoutMs` (e.g. dropped by
 * the server's rate limit). Null means the server may or may not have the photo; the app counts it as not sent
 * (the server refuses a second copy of a planted photo it is already playing). An ack that still comes after the
 * timeout goes to `onLateAck`.
 */
export function sendPlantPhoto(
  socket: PlantingSocket,
  photoUrl: string,
  { timeoutMs = PLANT_ACK_TIMEOUT_MS, onLateAck }: SendPlantPhotoOptions = {},
): Promise<PlantPhotoAck | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: PlantPhotoAck | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("disconnect", onDisconnect);
      resolve(answer);
    };
    const onDisconnect = () => settle(null);
    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.on("disconnect", onDisconnect);
    const onAck = (answer: unknown) => {
      const ack = isPlantPhotoAck(answer) ? answer : null;
      if (settled) { if (ack) onLateAck?.(ack); } else settle(ack);
    };
    if (!emitWhileConnected(socket, "plant-photo", { photoUrl }, onAck)) settle(null);
  });
}

/** The server has no such upload of mine any more: uploading the photo again and re-sending it may succeed. */
export const isPhotoUnavailable = (ack: PlantPhotoAck | null): boolean =>
  ack?.ok === false && ack.reason === "photo-unavailable";

/**
 * A refusal that sending again won't fix (vs. no answer or not in the room yet, which the rejoin's room-of-game
 * plants again): the lobby reports the photo as not uploaded.
 */
export const isFinalRefusal = (ack: PlantPhotoAck | null): boolean => ack?.ok === false && ack.reason !== "not-in-room";
