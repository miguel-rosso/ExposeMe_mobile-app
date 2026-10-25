import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-039 / EXP-040 over real sockets: every player gets waiting-photo (same payload, owner secret), and the
// owner's photo-unavailable skips the round at once; anyone else's is ignored. Production timings.

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Resolves true if `event` is NOT received within `ms`. */
function silent(socket: ClientSocket, event: string, ms = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

/** Started game; resolves once the first waiting-photo reached everyone and the owner got your-turn. */
async function gameWaitingForPhoto(names: string[]) {
  const socks: Record<string, ClientSocket> = {};
  socks[names[0]] = await newClient();
  const created = once<{ room: { gameCode: string } }>(socks[names[0]], "room-of-game");
  socks[names[0]].emit("join-create-game", { gameCode: null, username: names[0] });
  const gameCode = (await created).room.gameCode;
  for (const n of names.slice(1)) {
    socks[n] = await newClient();
    const joined = once(socks[n], "room-of-game");
    socks[n].emit("join-create-game", { gameCode, username: n });
    await joined;
  }
  const turns = names.map((n) => once<Turn>(socks[n], "your-turn").then((turn) => ({ n, turn })).catch(() => null));
  const waiting = names.map((n) => once<{ round: number; duration: number }>(socks[n], "waiting-photo"));
  const started = names.map((n) => once(socks[n], "game-started"));
  socks[names[0]].emit("start-game");
  await Promise.all(started);
  names.forEach((n) => socks[n].emit("im-ready"));
  const payloads = await Promise.all(waiting);
  const { n: owner, turn } = await Promise.race(turns.map((p) => p.then((x) => x ?? new Promise<{ n: string; turn: Turn }>(() => {}))));
  return { socks, owner, turn, payloads };
}

interface Turn { round: number; attempt: number }

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear();
  vi.restoreAllMocks();
});

describe("waiting for the chosen player's photo", () => {
  it("every player gets the same waiting-photo; the owner's photo-unavailable skips at once, others' are ignored", async () => {
    const names = ["wa", "wb", "wc"];
    const { socks, owner, turn, payloads } = await gameWaitingForPhoto(names);
    payloads.forEach((p) => expect(p).toEqual({ round: 1, duration: 15_000 }));
    expect(turn).toEqual({ round: 1, attempt: 1 });

    // A non-owner can't skip someone else's turn, even echoing the right request
    const other = names.find((n) => n !== owner)!;
    const noSkip = silent(socks[owner], "round-skipped", 300);
    socks[other].emit("photo-unavailable", turn);
    expect(await noSkip).toBe(true);

    // The owner's malformed or mismatched reports are ignored; the one for the current request skips at once for
    // everyone (events of one socket are handled in order, so the bad ones were processed first)
    const t0 = Date.now();
    const skipped = names.map((n) => once<{ round: number; reason: string }>(socks[n], "round-skipped", 2_000));
    const again = names.map((n) => once<{ round: number }>(socks[n], "waiting-photo", 2_000));
    const ownerTurnAgain = silent(socks[owner], "your-turn", 300);
    socks[owner].emit("photo-unavailable");
    socks[owner].emit("photo-unavailable", { round: "1", attempt: 1 });
    socks[owner].emit("photo-unavailable", { round: 1, attempt: 2 });
    socks[owner].emit("photo-unavailable", { round: 2, attempt: 1 });
    socks[owner].emit("photo-unavailable", turn);
    socks[owner].emit("photo-unavailable", turn); // duplicate: ignored
    (await Promise.all(skipped)).forEach((s) => expect(s).toEqual({ round: 1, reason: "unavailable" }));
    expect(Date.now() - t0).toBeLessThan(1_500);
    (await Promise.all(again)).forEach((w) => expect(w).toEqual({ round: 1, duration: 15_000 }));
    expect(await ownerTurnAgain).toBe(true);
    expect(await silent(socks[other], "round-skipped", 300)).toBe(true);
    Object.values(socks).forEach((c) => c.emit("leave-room"));
  }, 20_000);
});
