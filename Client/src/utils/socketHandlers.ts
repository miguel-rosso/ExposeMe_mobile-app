// ── Socket listeners of one component ──
// The app shares a single socket between screens and hooks, and several of them listen to the same events (e.g. the
// lobby and the game screen both handle game-state). So a component removes exactly the handlers it attached, never
// every listener of an event (socket.off(event) without a handler), whatever order React runs the effects in.

type SocketHandler = (...args: any[]) => void;
export type SocketHandlers = Record<string, SocketHandler>;

/** What this needs from a socket.io client socket */
interface ListenerTarget {
  on(event: string, handler: SocketHandler): unknown;
  off(event: string, handler: SocketHandler): unknown;
}

/** Attaches every handler of the table; the returned function removes exactly those (only once, later calls do nothing). */
export function attachHandlers(socket: ListenerTarget, handlers: SocketHandlers): () => void {
  const entries = Object.entries(handlers);
  entries.forEach(([event, handler]) => socket.on(event, handler));
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    entries.forEach(([event, handler]) => socket.off(event, handler));
  };
}
