import type { Server } from "socket.io";

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
