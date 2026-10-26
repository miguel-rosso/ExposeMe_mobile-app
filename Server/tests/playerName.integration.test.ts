import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// EXP-032: join-create-game refuses invisible characters and names that read the same as a player's in the room,
// admits emoji/symbol/ASCII-art names (DEC-033), and the stored name (exactly as typed) still rejoins with its token.

interface RoomOfGame {
  success: boolean;
  message?: string;
  rejoinToken?: string;
  room?: { gameCode: string; players: { username: string }[] };
}

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

async function joinAs(gameCode: string | null, username: string, rejoinToken?: string): Promise<RoomOfGame> {
  const sock = await newClient();
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken !== undefined ? { rejoinToken } : {}) });
  return res;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
});

afterAll(async () => {
  roomManager.clear();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe("join-create-game player names", () => {
  it.each([
    ["zero-width space", "bob\u200B"],
    ["right-to-left override", "\u202Ebob"],
    ["hangul filler only", "\u3164"],
  ])("refuses a name with %s as \"Invalid username\" (create and join)", async (_label, name) => {
    expect(await joinAs(null, name)).toEqual({ success: false, message: "Invalid username" });
    const { room } = await joinAs(null, "host");
    expect(await joinAs(room!.gameCode, name)).toEqual({ success: false, message: "Invalid username" });
  });

  it.each([
    ["Greek nu in Dave", "Da\u03BDe"],
    ["Greek upsilon in Paul", "Pa\u03C5l"],
    ["Armenian oh in bob", "b\u0585b"],
  ])("refuses Latin mixed with a lookalike script (%s) as \"Invalid username\"", async (_label, name) => {
    const { room } = await joinAs(null, "Dave");
    expect((await joinAs(room!.gameCode, "Paul")).success).toBe(true);
    expect(await joinAs(room!.gameCode, name)).toEqual({ success: false, message: "Invalid username" });
  });

  it.each([
    ["trailing space", "bob", "bob "],
    ["case variant", "bob", "BOB"],
    ["Latin small capital", "Dave", "D\u1D00ve"],
    ["all-Cherokee", "Dave", "\u13A0\u13AA\u13D9\u13AC"],
    ["Canadian Syllabics A", "Alice", "\u15C5lice"],
    ["Hebrew drawn reversed", "Milo", "Mi\u05E1\u05D5"],
  ])("refuses another spelling of a player's name (%s) as \"Username already taken\"", async (_label, existing, lookalike) => {
    const { room } = await joinAs(null, existing);
    expect(await joinAs(room!.gameCode, lookalike)).toEqual({ success: false, message: "Username already taken" });
    expect((await joinAs(room!.gameCode, "Rob")).success).toBe(true);
  });

  it.each([
    ["capital I as l", "Alice", "AIice"],
    ["cl as d", "Dara", "Clara"],
  ])("refuses a name that only looks like a player's (%s) as \"Username too similar\"", async (_label, existing, lookalike) => {
    const { room } = await joinAs(null, existing);
    expect(await joinAs(room!.gameCode, lookalike)).toEqual({ success: false, message: "Username too similar" });
    expect((await joinAs(room!.gameCode, "Rob")).success).toBe(true);
  });

  it("admits names made of emoji, symbols or ASCII art, and refuses their lookalikes", async () => {
    const created = await joinAs(null, "(\u2022_\u2022)");
    expect(created.success).toBe(true);
    const { gameCode } = created.room!;
    for (const name of ["\u00AF\\_(\u30C4)_/\u00AF", "\u{1F525}\u{1F525}", "<3 <3", "!!", "(\u30CE\u0CA0\u76CA\u0CA0)\u30CE"]) {
      expect((await joinAs(gameCode, name)).success).toBe(true);
    }
    expect(await joinAs(gameCode, "(\u2022_\u2022) ")).toEqual({ success: false, message: "Username already taken" });
    expect(await joinAs(gameCode, "\uFF1C\uFF13 <3")).toEqual({ success: false, message: "Username already taken" });
  });

  it("keeps the name as typed and rejoins with it and its token", async () => {
    const created = await joinAs(null, "bob ");
    const gameCode = created.room!.gameCode;
    expect(created.room!.players.map((p) => p.username)).toEqual(["bob "]);
    clients[0].disconnect();

    const back = await joinAs(gameCode, "bob ", created.rejoinToken);
    expect(back).toMatchObject({ success: true, rejoinToken: created.rejoinToken });
    expect(back.room!.players.map((p) => p.username)).toEqual(["bob "]);
  });
});
