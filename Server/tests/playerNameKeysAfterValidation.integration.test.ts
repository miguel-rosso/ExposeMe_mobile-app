import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { nameKeys } from "../managers/playerName";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-374: nameKeys only runs on a name isValidUsername accepted. Its regexes rely on the bounds of a valid name (15
// units, at most four marks in a row): the lookbehind that keeps a virama on a letter of its script is quadratic in a
// run of marks, so a join must be refused before RoomManager computes any key.

vi.mock("../managers/playerName", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managers/playerName")>();
  return { ...actual, nameKeys: vi.fn(actual.nameKeys) };
});

interface RoomOfGame {
  success: boolean;
  message?: string;
  room?: { gameCode: string };
}

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

async function joinAs(username: string, gameCode: string | null = null): Promise<RoomOfGame> {
  const sock = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(sock);
  await once(sock, "connect");
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username });
  return res;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
  vi.mocked(nameKeys).mockClear();
});

afterAll(async () => {
  roomManager.clear();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

const KA = String.fromCodePoint(0x0915);
const VIRAMA = String.fromCodePoint(0x094d);
const NUKTA = String.fromCodePoint(0x093c);

describe("name keys after validation (EXP-374)", () => {
  it.each([
    ["a run of viramas", KA + VIRAMA.repeat(14)],
    ["a run of nuktas before a virama", KA + NUKTA.repeat(13) + VIRAMA],
    ["a long run of marks", KA + (NUKTA + VIRAMA).repeat(7)],
  ])("refuses %s joining a room before computing any key", async (_label, username) => {
    const created = await joinAs("host");
    vi.mocked(nameKeys).mockClear();
    const res = await joinAs(username, created.room!.gameCode);
    expect(res).toMatchObject({ success: false, message: "Invalid username" });
    expect(nameKeys).not.toHaveBeenCalled();
  });

  it("computes the keys of an accepted name joining a room", async () => {
    const created = await joinAs("host");
    const username = KA + VIRAMA + String.fromCodePoint(0x0937);
    const res = await joinAs(username, created.room!.gameCode);
    expect(res.success).toBe(true);
    expect(nameKeys).toHaveBeenCalledWith(username);
  });
});
