import type { Server } from "socket.io";
import { uploadStore } from "../middlewares/uploadStore";

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
 * Events a socket received from the captured emits: those sent to its own id, plus room-wide ones (`room`) unless
 * it was the excluded socket.
 */
export function receivedBy(emits: CapturedEmit[], socketId: string, room: string): CapturedEmit[] {
  return emits.filter((e) => e.target === socketId || (e.target === room && e.except !== socketId));
}
