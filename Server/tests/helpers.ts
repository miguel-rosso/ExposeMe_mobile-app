import type { Server } from "socket.io";
import { UploadRecord, uploadStore } from "../middlewares/uploadStore";
import type { Player } from "../models/interfaces";

export interface CapturedEmit {
  target: string;
  /** io.to(target).except(except): every socket in `target` but this one */
  except?: string;
  event: string;
  args: unknown[];
}

/** Minimal stand-in for socket.io's Server: records every io.to(target)[.except(id)].emit(...) call. */
export function createFakeIo(): { io: Server; emits: CapturedEmit[] } {
  const emits: CapturedEmit[] = [];
  const emitter = (target: string, except?: string) => ({
    emit: (event: string, ...args: unknown[]) => {
      emits.push({ target, ...(except !== undefined ? { except } : {}), event, args });
      return true;
    },
  });
  const io = {
    to: (target: string) => ({
      ...emitter(target),
      except: (except: string) => emitter(target, except),
    }),
  };
  return { io: io as unknown as Server, emits };
}

/** Records `photo` (a `/temp/<name>` path) as uploaded by `username` in `gameCode`; no file is written. */
function register(gameCode: string, username: string, photo: string, meta: Pick<UploadRecord, "kind" | "round">): void {
  const name = photo.replace(/^\/temp\//, "");
  const record = { gameCode, username, file: `/nonexistent/exposeme-test/${name}`, ...meta };
  uploadStore.register(name, record, uploadStore.epoch(gameCode));
}

/**
 * Records `photo` (a `/temp/<name>` path) as a lobby upload of `username` in room `gameCode` (a planted-photo pick,
 * as POST /upload stores it outside the uploader's photo turn), so plant-photo accepts it without a real upload.
 * photo-sent never takes it: use registerTurnUpload for that. No file is written (deleting it later is a no-op).
 */
export function registerUpload(gameCode: string, username: string, photo: string): void {
  register(gameCode, username, photo, { kind: "planted", round: 0 });
}

/**
 * Records `photo` as `username`'s turn photo for game round `round` (the `round` of their your-turn / of the
 * round-start it will start), as POST /upload stores it while that photo is awaited (room.round is `round - 1`
 * then). photo-sent accepts it only for that round. No file is written (deleting it later is a no-op).
 */
export function registerTurnUpload(gameCode: string, username: string, photo: string, round: number): void {
  register(gameCode, username, photo, { kind: "turn", round: round - 1 });
}

/**
 * `player` planted `photo` (a `/temp/<name>` path) in the lobby, as POST /upload + plant-photo do: the upload is
 * registered (fresh, so it is not expired) and becomes the player's planted photo.
 */
export function plantPhoto(gameCode: string, player: Player, photo: string): void {
  registerUpload(gameCode, player.username, photo);
  uploadStore.replacePlanted(player.plantedPhoto, photo); // claimed: not dropped as an unclaimed upload
  player.plantedPhoto = photo;
  player.hasPlantedPhoto = true;
}

/**
 * Events a socket received from the captured emits: those sent to its own id, plus room-wide ones (`room`) unless
 * it was the excluded socket.
 */
export function receivedBy(emits: CapturedEmit[], socketId: string, room: string): CapturedEmit[] {
  return emits.filter((e) => e.target === socketId || (e.target === room && e.except !== socketId));
}
