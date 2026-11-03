import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { QA_ACK_BURST, QaAckRecord } from "../managers/qaTelemetry";

// EXP-012: `qa-ack` is handled only when the server runs with QA_TELEMETRY=1. Each test loads a fresh server with its
// env (the flag is read when socketRoutes loads). The sink writes synchronously and socket.io handles a socket's events
// in order, so once a later event on the same socket has been answered (a barrier) every earlier ack is on disk.

let dir: string;
let file: string;
let clients: ClientSocket[] = [];
let stopServer: () => Promise<void> = async () => {};

async function startServer(env: Record<string, string | undefined>): Promise<string> {
  const saved = { QA_TELEMETRY: process.env.QA_TELEMETRY, QA_TELEMETRY_FILE: process.env.QA_TELEMETRY_FILE };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  vi.resetModules();
  const { io, server } = await import("../app");
  const { roomManager } = await import("../routes/socketRoutes");
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopServer = async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    roomManager.clear();
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends `event` on `sock` and resolves once the server answers with `reply` on it. */
function roundTrip(sock: ClientSocket, event: string, data: unknown, reply: string): Promise<unknown> {
  const answered = new Promise((resolve) => sock.once(reply, resolve));
  sock.emit(event, data);
  return answered;
}

/** A connected client that created its own room as `username` (so it is the host). */
async function joinedClient(url: string, username: string): Promise<{ sock: ClientSocket; gameCode: string }> {
  const sock = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(sock);
  const joined = await roundTrip(sock, "join-create-game", { gameCode: null, username }, "room-of-game");
  return { sock, gameCode: (joined as { room: { gameCode: string } }).room.gameCode };
}

/** Barrier on a host's socket: every event it sent before set-rounds has been handled. */
const barrier = (host: ClientSocket) => roundTrip(host, "set-rounds", { rounds: 15 }, "rounds-updated");

const ack = (round: number) => ({ phase: "answering", round, at: 1_700_000_000_000 + round, platform: "ios" });

/** The recorded lines (qa-photo-shown ones too: those tests only compare whole lines) */
function records(): QaAckRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "qa-ack-"));
  file = join(dir, "telemetry.jsonl");
});

afterEach(async () => {
  clients.forEach((c) => c.disconnect());
  clients = [];
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("qa-ack with QA_TELEMETRY=1", () => {
  it("records each valid ack with the session identity and the receipt time", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const { sock, gameCode } = await joinedClient(url, "alice");
    const before = Date.now();
    // Identity in the payload is ignored: the session decides
    sock.emit("qa-ack", { ...ack(1), gameCode: "ZZZZZZ", username: "mallory" });
    await barrier(sock);
    const entries = records();
    expect(entries).toEqual([{ gameCode, username: "alice", ...ack(1), receivedAt: expect.any(Number) }]);
    expect(entries[0].receivedAt).toBeGreaterThanOrEqual(before);
  });

  it("records the device handler time and, for the room's current phase, the server emit time (EXP-223)", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const { sock: host, gameCode } = await joinedClient(url, "alice");
    const guest = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    clients.push(guest);
    await roundTrip(guest, "join-create-game", { gameCode, username: "bob" }, "room-of-game");
    await roundTrip(host, "start-game", undefined, "game-started");
    const waiting = new Promise((resolve) => host.once("waiting-photo", resolve));
    const before = Date.now();
    host.emit("im-ready");
    guest.emit("im-ready");
    await waiting;
    host.emit("qa-ack", { phase: "waiting-photo", round: 1, at: 2_000, platform: "android", handledAt: 1_990 });
    host.emit("qa-ack", { phase: "answering", round: 1, at: 3_000, platform: "android" }); // not the room's phase: no serverAt
    // No barrier mid-game (set-rounds is refused once started): wait for both lines
    await vi.waitFor(() => expect(records()).toHaveLength(2));
    const [current, other] = records();
    expect(current).toEqual({
      gameCode, username: "alice", phase: "waiting-photo", round: 1, at: 2_000, platform: "android", handledAt: 1_990,
      receivedAt: expect.any(Number), serverAt: expect.any(Number),
    });
    expect(current.serverAt).toBeGreaterThanOrEqual(before);
    expect(current.serverAt).toBeLessThanOrEqual(current.receivedAt);
    expect(other).toEqual({
      gameCode, username: "alice", phase: "answering", round: 1, at: 3_000, platform: "android", receivedAt: expect.any(Number),
    });
  });

  it("drops invalid payloads and acks from sockets without a session", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const stranger = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
    clients.push(stranger);
    stranger.emit("qa-ack", ack(1));
    // Answered after its ack was handled (the join gives it a session only from here on)
    await roundTrip(stranger, "join-create-game", { gameCode: null, username: "stranger" }, "room-of-game");
    const { sock } = await joinedClient(url, "alice");
    sock.emit("qa-ack", { phase: "lobby", round: 1, at: 1 });
    sock.emit("qa-ack", { phase: "answering", round: "1", at: 1 });
    sock.emit("qa-ack", null);
    sock.emit("qa-ack", { ...ack(1), handledAt: "earlier" });
    sock.emit("qa-ack", { ...ack(1), platform: undefined }); // EXP-395: the platform is required
    sock.emit("qa-ack", ack(2)); // the only valid one
    await barrier(sock);
    expect(records().map((r) => r.round)).toEqual([2]);
  });

  it("rate-limits acks per socket, keeping the order they arrived in", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const { sock } = await joinedClient(url, "alice");
    for (let i = 0; i < QA_ACK_BURST * 3; i++) sock.emit("qa-ack", ack(i));
    await barrier(sock);
    const rounds = records().map((r) => r.round);
    // The burst plus at most a token refilled while the flood arrived
    expect(rounds.length).toBeGreaterThanOrEqual(QA_ACK_BURST);
    expect(rounds.length).toBeLessThanOrEqual(QA_ACK_BURST + 1);
    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
  });
});

// EXP-395: the round photo on screen, recorded next to the phase acks
describe("qa-photo-shown with QA_TELEMETRY=1", () => {
  const shown = (round: number) => ({ phase: "answering", round, at: 1_700_000_000_500 + round, platform: "ios" });

  it("records each valid one with its kind, the session identity and the receipt time; drops the rest", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const { sock, gameCode } = await joinedClient(url, "alice");
    sock.emit("qa-photo-shown", { ...shown(1), gameCode: "ZZZZZZ", username: "mallory" });
    sock.emit("qa-photo-shown", { ...shown(2), platform: "web" });
    sock.emit("qa-photo-shown", { ...shown(3), failed: true });
    await barrier(sock);
    expect(records()).toEqual([
      { kind: "photo-shown", gameCode, username: "alice", ...shown(1), receivedAt: expect.any(Number) },
      { kind: "photo-shown", gameCode, username: "alice", ...shown(3), failed: true, receivedAt: expect.any(Number) },
    ]);
  });

  it("shares the qa-ack budget of the socket", async () => {
    const url = await startServer({ QA_TELEMETRY: "1", QA_TELEMETRY_FILE: file });
    const { sock } = await joinedClient(url, "alice");
    for (let i = 0; i < QA_ACK_BURST; i++) sock.emit("qa-ack", ack(i));
    for (let i = 0; i < QA_ACK_BURST; i++) sock.emit("qa-photo-shown", shown(i));
    await barrier(sock);
    // The burst plus at most a token refilled while the flood arrived
    expect(records().length).toBeLessThanOrEqual(QA_ACK_BURST + 1);
  });
});

describe("qa-ack without QA_TELEMETRY", () => {
  it("is ignored (nothing recorded) even with a file configured", async () => {
    const url = await startServer({ QA_TELEMETRY: undefined, QA_TELEMETRY_FILE: file });
    const { sock } = await joinedClient(url, "alice");
    sock.emit("qa-ack", ack(1));
    sock.emit("qa-photo-shown", { phase: "answering", round: 1, at: 1, platform: "ios" });
    await barrier(sock); // the ack had its chance
    expect(existsSync(file)).toBe(false);
  });
});
