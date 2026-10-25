import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";

// A phone that silently loses network (no TCP close) must be detected by the heartbeat and marked
// disconnected within PING_INTERVAL + PING_TIMEOUT, so it is no longer picked as the photo owner.

const INTERVAL = 200;
const TIMEOUT = 300;
const SLACK = 400;

type AppModule = typeof import("../app");
type RoutesModule = typeof import("../routes/socketRoutes");

let app: AppModule;
let routes: RoutesModule;
let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

async function joinAs(sock: ClientSocket, gameCode: string | null, username: string) {
  const res = once<{ success: boolean; room?: { gameCode: string } }>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username });
  return res;
}

/** Stop answering server pings while keeping the TCP connection open (like a phone that lost signal). */
function goSilent(sock: ClientSocket): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = sock.io.engine as any;
  // Relies on an engine.io-client internal: fail loudly if an upgrade renames it
  expect(typeof engine._sendPacket).toBe("function");
  const send = engine._sendPacket.bind(engine);
  engine._sendPacket = (type: string, ...rest: unknown[]) => (type === "pong" ? undefined : send(type, ...rest));
}

function isConnected(gameCode: string, username: string): boolean | undefined {
  return routes.roomManager.getRoom(gameCode)?.players.find((p) => p.username === username)?.connected;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("SOCKET_PING_INTERVAL_MS", String(INTERVAL));
  vi.stubEnv("SOCKET_PING_TIMEOUT_MS", String(TIMEOUT));
  app = await import("../app");
  routes = await import("../routes/socketRoutes");
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => app.io.close(() => resolve()));
  routes.roomManager.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("socket heartbeat", () => {
  it("uses env-overridable ping values", () => {
    expect(app.PING_INTERVAL).toBe(INTERVAL);
    expect(app.PING_TIMEOUT).toBe(TIMEOUT);
  });

  it("marks a client that stops answering pings as disconnected within interval + timeout", async () => {
    const alice = await newClient();
    const gameCode = (await joinAs(alice, null, "alice")).room!.gameCode;
    const bob = await newClient();
    expect((await joinAs(bob, gameCode, "bob")).success).toBe(true);
    expect(isConnected(gameCode, "bob")).toBe(true);

    goSilent(bob);
    const silentAt = Date.now();
    while (isConnected(gameCode, "bob") && Date.now() - silentAt < INTERVAL + TIMEOUT + SLACK) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isConnected(gameCode, "bob")).toBe(false);
    expect(Date.now() - silentAt).toBeLessThan(INTERVAL + TIMEOUT + SLACK);

    // A client that keeps answering is not dropped over the same period
    expect(isConnected(gameCode, "alice")).toBe(true);
    expect(alice.connected).toBe(true);
  });

  it("clamps env overrides to 1s..300s outside tests and ignores invalid values", () => {
    const key = "SOCKET_PING_TEST_MS";
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv(key, "50");
      expect(app.envMs(key, 10_000)).toBe(1_000);
      vi.stubEnv(key, "999999999");
      expect(app.envMs(key, 10_000)).toBe(300_000);
      vi.stubEnv(key, "20000");
      expect(app.envMs(key, 10_000)).toBe(20_000);
      for (const bad of ["", "abc", "-5", "0", "Infinity"]) {
        vi.stubEnv(key, bad);
        expect(app.envMs(key, 10_000)).toBe(10_000);
      }

      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv(key, "50");
      expect(app.envMs(key, 10_000)).toBe(50);
      vi.stubEnv(key, "999999999");
      expect(app.envMs(key, 10_000)).toBe(300_000);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("SOCKET_PING_INTERVAL_MS", String(INTERVAL));
      vi.stubEnv("SOCKET_PING_TIMEOUT_MS", String(TIMEOUT));
    }
  });

  it("defaults detect a silent client within 30s without a too-aggressive pong timeout", async () => {
    vi.unstubAllEnvs();
    delete process.env.SOCKET_PING_INTERVAL_MS;
    delete process.env.SOCKET_PING_TIMEOUT_MS;
    vi.resetModules();
    const fresh: AppModule = await import("../app");
    try {
      expect(fresh.PING_INTERVAL + fresh.PING_TIMEOUT).toBeLessThanOrEqual(30_000);
      expect(fresh.PING_TIMEOUT).toBeGreaterThanOrEqual(10_000);
    } finally {
      fresh.io.close();
    }
  });
});
