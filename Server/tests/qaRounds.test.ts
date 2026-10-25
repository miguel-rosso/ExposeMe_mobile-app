import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { isAllowedRounds } from "../managers/RoomManager";
import { roomManager } from "../routes/socketRoutes";

// EXP-100: 3-round games exist only for QA (short device runs). The server accepts them only with ALLOW_QA_ROUNDS=1
// (set by qa/lab/lab.sh server); production runs without it and keeps 10/15/20.

describe("isAllowedRounds", () => {
  it("accepts 10/15/20 with or without the QA flag", () => {
    for (const r of [10, 15, 20]) {
      expect(isAllowedRounds(r, {})).toBe(true);
      expect(isAllowedRounds(r, { ALLOW_QA_ROUNDS: "1" })).toBe(true);
    }
  });

  it("rejects 3 rounds unless ALLOW_QA_ROUNDS=1", () => {
    expect(isAllowedRounds(3, {})).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "0" })).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "true" })).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "1" })).toBe(true);
  });

  it("rejects anything else even with the QA flag", () => {
    for (const r of [0, 1, 2, 4, 5, 11, 100, -3, NaN, "3", null, undefined]) {
      expect(isAllowedRounds(r, { ALLOW_QA_ROUNDS: "1" })).toBe(false);
    }
  });
});

// ── set-rounds over a real socket ──

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

function silent(socket: ClientSocket, event: string, ms = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

async function hostLobby(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  const res = once(c, "room-of-game");
  c.emit("join-create-game", { gameCode: null, username: "host" });
  await res;
  return c;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
});

describe("set-rounds", () => {
  it("ignores rounds: 3 when the server runs without ALLOW_QA_ROUNDS", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "");
    const host = await hostLobby();
    const quiet = silent(host, "rounds-updated");
    host.emit("set-rounds", { rounds: 3 });
    expect(await quiet).toBe(true);
  });

  it("accepts rounds: 3 when ALLOW_QA_ROUNDS=1", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "1");
    const host = await hostLobby();
    const updated = once<number>(host, "rounds-updated");
    host.emit("set-rounds", { rounds: 3 });
    expect(await updated).toBe(3);
  });

  it("still accepts 10/15/20 without the flag", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "");
    const host = await hostLobby();
    for (const r of [15, 20, 10]) {
      const updated = once<number>(host, "rounds-updated");
      host.emit("set-rounds", { rounds: r });
      expect(await updated).toBe(r);
    }
  });
});
