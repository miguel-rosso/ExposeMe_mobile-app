import type { Socket } from "socket.io-client";
import { emitWhileConnected } from "./socketEmit";

export type AckSocket = Pick<Socket, "connected" | "emit" | "on" | "off">;

/** Shape every `{ ok: true } | { ok: false, reason }` ack shares: an object with a boolean `ok`. */
export const hasBooleanOk = (answer: unknown): answer is { ok: boolean } =>
  typeof answer === "object" && answer !== null && typeof (answer as { ok?: unknown }).ok === "boolean";

export interface AwaitAckOptions<T> {
  timeoutMs: number;
  /** The ack arrived after `timeoutMs` (a slow server on a live connection): the promise already resolved null. */
  onLateAck?: (answer: T) => void;
}

/**
 * Emits `event` with `args` and an ack callback, and resolves with the server's answer, or null when there is none:
 * not connected (never emitted, see emitWhileConnected), the connection dropped while waiting, no answer within
 * `timeoutMs` (e.g. dropped by the server's rate limit), or an answer `isAck` doesn't accept. An ack that still comes
 * after the timeout goes to `onLateAck`.
 */
export function emitAwaitingAck<T>(
  socket: AckSocket,
  event: string,
  args: unknown[],
  isAck: (answer: unknown) => answer is T,
  { timeoutMs, onLateAck }: AwaitAckOptions<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: T | null) => {
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
      const ack = isAck(answer) ? answer : null;
      if (settled) { if (ack) onLateAck?.(ack); } else settle(ack);
    };
    if (!emitWhileConnected(socket, event, ...args, onAck)) settle(null);
  });
}
