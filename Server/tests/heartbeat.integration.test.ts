import { afterAll, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import * as app from "../app";
import { roomManager } from "../routes/socketRoutes";
import { useTestServer } from "./socketHarness";

// A phone that silently loses network (no TCP close) must be detected by the heartbeat and marked
// disconnected within PING_INTERVAL + PING_TIMEOUT, so it is no longer picked as the photo owner.

// Short ping values, stubbed before ../app (which reads them when it loads) is imported
const { INTERVAL, TIMEOUT } = vi.hoisted(() => {
  const ping = { INTERVAL: 200, TIMEOUT: 300 };
  vi.stubEnv("SOCKET_PING_INTERVAL_MS", String(ping.INTERVAL));
  vi.stubEnv("SOCKET_PING_TIMEOUT_MS", String(ping.TIMEOUT));
  return ping;
});
const SLACK = 400;

type AppModule = typeof import("../app");

const { newClient, joinAs } = useTestServer();

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
  return roomManager.getRoom(gameCode)?.players.find((p) => p.username === username)?.connected;
}

afterAll(() => {
  vi.unstubAllEnvs();
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
      vi.stubEnv(key, "1500.6");
      expect(app.envMs(key, 10_000)).toBe(1_501);
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

  it("warns about an invalid env override, like envInt, but not about an unset or valid one", () => {
    const key = "SOCKET_PING_TEST_MS";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bad of ["abc", "-5", "0", "Infinity"]) {
        warn.mockClear();
        vi.stubEnv(key, bad);
        expect(app.envMs(key, 10_000)).toBe(10_000);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain(`${key}=${bad}`);
      }
      warn.mockClear();
      for (const quiet of ["", "  ", "20000", "1500.6"]) {
        vi.stubEnv(key, quiet);
        app.envMs(key, 10_000);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
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
