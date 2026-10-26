type Handler = (...args: any[]) => void;

/**
 * In-memory stand-in for the app's socket.io client socket: records what the app emits and lets a test play the
 * server's events (`fire`) to every listener the screens attached. Name the instance `mockSocket` so jest.mock
 * factories may reference it.
 */
export class FakeSocket {
  connected = true;
  /** socket.io's `active`: set it to false to play a connection the server refused (no reconnection will follow). */
  active = true;
  /** Spies, so a test can assert the app (did not) open or drop the connection. */
  connect = jest.fn(() => this);
  disconnect = jest.fn(() => this);
  handlers = new Map<string, Set<Handler>>();
  emitted: [string, ...any[]][] = [];

  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(fn);
    return this;
  }
  off(ev: string, fn?: Handler) {
    if (fn) this.handlers.get(ev)?.delete(fn);
    else this.handlers.delete(ev);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  emit(ev: string, ...args: any[]) {
    this.emitted.push([ev, ...args]);
    return this;
  }
  /** Plays a server event to every listener attached right now. */
  fire(ev: string, ...args: any[]) {
    [...(this.handlers.get(ev) ?? [])].forEach((fn) => fn(...args));
  }
  /** First argument of every `ev` the app emitted, in order. */
  emittedPayloads(ev: string) {
    return this.emitted.filter(([e]) => e === ev).map(([, payload]) => payload);
  }
  listenerCount(ev: string) {
    return this.handlers.get(ev)?.size ?? 0;
  }
  /** Back to a fresh, connected socket with no listeners, nothing emitted and clean connect/disconnect spies. */
  reset() {
    this.connected = true;
    this.active = true;
    this.handlers.clear();
    this.emitted = [];
    this.connect.mockClear();
    this.disconnect.mockClear();
  }
}
