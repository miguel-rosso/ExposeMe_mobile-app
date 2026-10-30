import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import type { RoomOfGameResponse } from "../models/interfaces";
import { roomManager } from "../routes/socketRoutes";

// Shared harness for the socket/HTTP integration tests: the real app on an ephemeral port, socket.io clients that
// are closed with it, and the event helpers every such test needs.

const DEFAULT_EVENT_TIMEOUT_MS = 4_000;
const DEFAULT_QUIET_MS = 300;
/** One fresh websocket connection per client, never retried: a dropped socket stays dropped */
const CLIENT_OPTIONS = { transports: ["websocket"], forceNew: true, reconnection: false };

export interface ReceivedEvent {
  event: string;
  args: unknown[];
}

export interface TestServerOptions {
  /** Default timeout of once() (ms) */
  eventTimeoutMs?: number;
  /** Default window of silent() (ms) */
  quietMs?: number;
  /** Record every event each client receives in `received` (for leak checks) */
  recordPayloads?: boolean;
  /**
   * After each test: delete every room (cancelling its game timers) and disconnect the test's clients, so no game
   * keeps running into the next test. Only for files whose tests share no room.
   */
  resetBetweenTests?: boolean;
}

/**
 * Registers the hooks that start the app server on 127.0.0.1:<ephemeral port> before the file's tests and close it
 * (clients, socket.io, rooms, mocks) after them. Call once, at the top level of a test file, before its own hooks.
 */
export function useTestServer(options: TestServerOptions = {}) {
  const {
    eventTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
    quietMs = DEFAULT_QUIET_MS,
    recordPayloads = false,
    resetBetweenTests = false,
  } = options;
  let url = "";
  let port = 0;
  const clients: ClientSocket[] = [];
  const received = new Map<ClientSocket, ReceivedEvent[]>();

  function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = eventTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
      socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
    });
  }

  /** Resolves true if `event` is NOT received within `ms`. */
  function silent(socket: ClientSocket, event: string, ms = quietMs): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = () => { clearTimeout(t); resolve(false); };
      const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
      socket.once(event, handler);
    });
  }

  /** Opens a client (not yet connected when it returns); it is closed with the server or by disconnectClients(). */
  function connectClient(extraHeaders?: Record<string, string>): ClientSocket {
    const c = connect(url, { ...CLIENT_OPTIONS, ...(extraHeaders ? { extraHeaders } : {}) });
    clients.push(c);
    if (recordPayloads) {
      const events: ReceivedEvent[] = [];
      received.set(c, events);
      c.onAny((event: string, ...args: unknown[]) => events.push({ event, args }));
    }
    return c;
  }

  async function newClient(): Promise<ClientSocket> {
    const c = connectClient();
    await once(c, "connect");
    return c;
  }

  function joinAs(sock: ClientSocket, gameCode: unknown, username: unknown, rejoinToken?: string): Promise<RoomOfGameResponse> {
    const res = once<RoomOfGameResponse>(sock, "room-of-game");
    sock.emit("join-create-game", { gameCode, username, ...(rejoinToken !== undefined ? { rejoinToken } : {}) });
    return res;
  }

  /** alice (host) + bob in a fresh lobby; alice's player-joined for bob is consumed here. */
  async function lobby(): Promise<{ gameCode: string; alice: ClientSocket; bob: ClientSocket; tokens: Record<string, string> }> {
    const alice = await newClient();
    const created = await joinAs(alice, null, "alice");
    const gameCode = created.room!.gameCode;
    const bob = await newClient();
    const announced = once(alice, "player-joined");
    const joined = await joinAs(bob, gameCode, "bob");
    expect(joined.success).toBe(true);
    await announced;
    return { gameCode, alice, bob, tokens: { alice: created.rejoinToken!, bob: joined.rejoinToken! } };
  }

  /** The host starts the game; resolves when every socket in `all` got game-started. */
  async function startGame(host: ClientSocket, all: ClientSocket[]): Promise<void> {
    const started = all.map((c) => once(c, "game-started"));
    host.emit("start-game");
    await Promise.all(started);
  }

  function disconnectClients(): void {
    clients.splice(0).forEach((c) => c.disconnect());
    received.clear();
  }

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });

  if (resetBetweenTests) {
    afterEach(() => {
      roomManager.clear(); // first: the disconnects below then find no room, so they start no grace / pause timer
      disconnectClients();
    });
  }

  afterAll(async () => {
    disconnectClients();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    roomManager.clear(); // pending room deletions / game timers must not outlive the server
    vi.restoreAllMocks();
  });

  return {
    /** http://127.0.0.1:<port>, set once the server listens */
    get url() { return url; },
    get port() { return port; },
    clients,
    received,
    once,
    silent,
    connectClient,
    newClient,
    joinAs,
    lobby,
    startGame,
    disconnectClients,
  };
}
