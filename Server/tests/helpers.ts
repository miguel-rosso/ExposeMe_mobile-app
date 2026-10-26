import type { Server } from "socket.io";
import { uploadStore } from "../middlewares/uploadStore";
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

/**
 * Records `photo` (a `/temp/<name>` path) as uploaded by `username` in room `gameCode`, as POST /upload does, so
 * photo-sent / plant-photo accept it without a real upload. No file is written (deleting it later is a no-op).
 */
export function registerUpload(gameCode: string, username: string, photo: string): void {
  const name = photo.replace(/^\/temp\//, "");
  uploadStore.register(name, { gameCode, username, file: `/nonexistent/exposeme-test/${name}` }, uploadStore.epoch(gameCode));
}

/**
 * `player` planted `photo` (a `/temp/<name>` path) in the lobby, as POST /upload + plant-photo do: the upload is
 * registered (fresh, so it is not expired) and becomes the player's planted photo.
 */
export function plantPhoto(gameCode: string, player: Player, photo: string): void {
  registerUpload(gameCode, player.username, photo);
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
