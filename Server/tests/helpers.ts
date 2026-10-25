import type { Server } from "socket.io";
import { uploadStore } from "../middlewares/uploadStore";

export interface CapturedEmit {
  target: string;
  event: string;
  args: unknown[];
}

/** Minimal stand-in for socket.io's Server: records every io.to(target).emit(...) call. */
export function createFakeIo(): { io: Server; emits: CapturedEmit[] } {
  const emits: CapturedEmit[] = [];
  const io = {
    to: (target: string) => ({
      emit: (event: string, ...args: unknown[]) => {
        emits.push({ target, event, args });
        return true;
      },
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
