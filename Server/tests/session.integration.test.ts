import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";

// Session hardening: identity (room + username) comes from the server-side session set on join,
// rejoining an existing username requires the rejoin token, and the token never leaves its owner.

interface RoomOfGame {
  success: boolean;
  message?: string;
  rejoinToken?: string;
  room?: { gameCode: string; rounds: number; players: Record<string, unknown>[] };
}

const QUIET_MS = 300;

let url: string;
const clients: ClientSocket[] = [];
/** Every payload received by each client, for leak checks. */
const received = new Map<ClientSocket, { event: string; args: unknown[] }[]>();

function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** Resolves true if `event` is NOT received within `ms`. */
function silent(socket: ClientSocket, event: string, ms = QUIET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { socket.off(event, handler); resolve(true); }, ms);
    socket.once(event, handler);
  });
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  received.set(c, []);
  c.onAny((event: string, ...args: unknown[]) => received.get(c)!.push({ event, args }));
  await once(c, "connect");
  return c;
}

async function joinAs(sock: ClientSocket, gameCode: string | null, username: string, rejoinToken?: string): Promise<RoomOfGame> {
  const res = once<RoomOfGame>(sock, "room-of-game");
  sock.emit("join-create-game", { gameCode, username, ...(rejoinToken !== undefined ? { rejoinToken } : {}) });
  return res;
}

/** alice (host) + bob in a fresh lobby. */
async function lobby(): Promise<{ gameCode: string; alice: ClientSocket; bob: ClientSocket; tokens: Record<string, string> }> {
  const alice = await newClient();
  const created = await joinAs(alice, null, "alice");
  const gameCode = created.room!.gameCode;
  const bob = await newClient();
  const joined = await joinAs(bob, gameCode, "bob");
  expect(joined.success).toBe(true);
  return { gameCode, alice, bob, tokens: { alice: created.rejoinToken!, bob: joined.rejoinToken! } };
}

async function startGame(gameCode: string, host: ClientSocket, all: ClientSocket[]): Promise<void> {
  const started = all.map((c) => once(c, "game-started"));
  host.emit("start-game", { gameCode });
  await Promise.all(started);
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => io.close(() => resolve()));
  roomManager.clear(); // pending room deletions / game timers must not outlive the server
  vi.restoreAllMocks();
});

// ── Join / rejoin ──────────────────────────────────────

describe("join and rejoin", () => {
  it("returns a random base64url rejoin token only to the joining socket", async () => {
    const { tokens } = await lobby();
    for (const t of Object.values(tokens)) expect(t).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(tokens.alice).not.toBe(tokens.bob);
  });

  it("rejects an existing username without a valid token in the lobby", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const other = await newClient();
    expect(await joinAs(other, gameCode, "bob")).toEqual({ success: false, message: "Username already taken" });
    expect(await joinAs(other, gameCode, "bob", "x".repeat(22))).toEqual({ success: false, message: "Username already taken" });
    expect(await joinAs(other, gameCode, "bob", tokens.alice)).toEqual({ success: false, message: "Username already taken" });

    // bob's session is untouched: he still receives room broadcasts on his socket
    const chat = once<{ username: string; message: string }>(bob, "chat-message");
    alice.emit("chat-message", { gameCode, username: "alice", message: "hi" });
    expect(await chat).toEqual({ username: "alice", message: "hi" });
  });

  it("rejects an existing username without a valid token after the game started", async () => {
    const { gameCode, alice, bob } = await lobby();
    await startGame(gameCode, alice, [alice, bob]);
    const other = await newClient();
    expect(await joinAs(other, gameCode, "bob")).toEqual({ success: false, message: "Game already started" });
    expect(await joinAs(other, gameCode, "bob", "not-the-token")).toEqual({ success: false, message: "Game already started" });
  });

  it("accepts a rejoin with the matching token (lobby and in-game)", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();

    bob.disconnect();
    const bob2 = await newClient();
    const res = await joinAs(bob2, gameCode, "bob", tokens.bob);
    expect(res.success).toBe(true);
    expect(res.rejoinToken).toBe(tokens.bob);
    expect(res.room!.players.find((p) => p.username === "bob")).toMatchObject({ connected: true });

    await startGame(gameCode, alice, [alice, bob2]);
    bob2.disconnect();
    const bob3 = await newClient();
    const res2 = await joinAs(bob3, gameCode, "bob", tokens.bob);
    expect(res2.success).toBe(true);
    expect(res2.rejoinToken).toBe(tokens.bob);
  });

  it("rejects invalid usernames", async () => {
    const c = await newClient();
    for (const username of ["", "   ", "x".repeat(21), 42, null]) {
      const res = once<RoomOfGame>(c, "room-of-game");
      c.emit("join-create-game", { gameCode: null, username });
      expect((await res).success).toBe(false);
    }
  });

  it("never sends a player's token to anyone else", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    const carol = await newClient();
    const carolJoin = await joinAs(carol, gameCode, "carol");
    tokens.carol = carolJoin.rejoinToken!;
    bob.emit("mark-player-planted", { gameCode, username: "bob" });
    bob.emit("plant-photo", { gameCode, username: "bob", photoUrl: "https://example.invalid/planted.jpg" });

    const started = [alice, bob, carol].map((c) => once<Record<string, unknown>[]>(c, "game-started"));
    alice.emit("start-game", { gameCode });
    for (const players of await Promise.all(started)) {
      for (const p of players) {
        expect(p).not.toHaveProperty("rejoinToken");
        expect(p).not.toHaveProperty("plantedPhoto");
      }
    }

    // carol's room-of-game lists alice and bob without their tokens
    for (const p of carolJoin.room!.players) expect(p).not.toHaveProperty("rejoinToken");

    const owner: Record<string, ClientSocket> = { alice, bob, carol };
    for (const [name, sock] of Object.entries(owner)) {
      const dump = JSON.stringify(received.get(sock));
      for (const [other, token] of Object.entries(tokens)) {
        if (other !== name) expect(dump).not.toContain(token);
      }
      expect(dump).not.toContain("planted.jpg");
    }
    // the joiner's own token only arrives in its own room-of-game
    const bobEvents = received.get(bob)!.filter((e) => JSON.stringify(e.args).includes(tokens.bob));
    expect(bobEvents.map((e) => e.event)).toEqual(["room-of-game"]);
  });
});

// ── Host-only lobby actions ────────────────────────────

describe("host-only actions", () => {
  it("ignores set-rounds from non-hosts and outsiders; accepts it from the host", async () => {
    const { gameCode, alice, bob } = await lobby();
    const outsider = await newClient();

    const quiet = silent(alice, "rounds-updated");
    bob.emit("set-rounds", { gameCode, rounds: 20 });
    outsider.emit("set-rounds", { gameCode, rounds: 20 });
    expect(await quiet).toBe(true);

    const updated = once<number>(bob, "rounds-updated");
    alice.emit("set-rounds", { gameCode: "000000", rounds: 15 });
    expect(await updated).toBe(15);
  });

  it("ignores start-game from non-hosts and outsiders", async () => {
    const { gameCode, alice, bob } = await lobby();
    const outsider = await newClient();
    const quiet = silent(alice, "game-started");
    bob.emit("start-game", { gameCode });
    outsider.emit("start-game", { gameCode });
    expect(await quiet).toBe(true);
  });
});

// ── Social ─────────────────────────────────────────────

describe("chat and emoji", () => {
  it("uses the session username and room, not the payload", async () => {
    const { gameCode, alice, bob } = await lobby();
    const outsider = await newClient();

    const chat = once<{ username: string; message: string }>(alice, "chat-message");
    bob.emit("chat-message", { gameCode, username: "alice", message: "hello" });
    expect(await chat).toEqual({ username: "bob", message: "hello" });

    const emoji = once<{ username: string; emoji: string }>(alice, "emoji-reaction");
    bob.emit("emoji-reaction", { gameCode, username: "alice", emoji: "🔥" });
    expect(await emoji).toEqual({ username: "bob", emoji: "🔥" });

    const quietChat = silent(alice, "chat-message", 400);
    const quietEmoji = silent(alice, "emoji-reaction", 400);
    outsider.emit("chat-message", { gameCode, username: "x", message: "spam" });
    outsider.emit("emoji-reaction", { gameCode, username: "x", emoji: "🔥" });
    await new Promise((r) => setTimeout(r, 300)); // chat cooldown
    bob.emit("emoji-reaction", { gameCode, emoji: { not: "a string" } });
    bob.emit("emoji-reaction", { gameCode, emoji: "x".repeat(50) });
    bob.emit("chat-message", { gameCode, message: 123 });
    expect(await quietChat).toBe(true);
    expect(await quietEmoji).toBe(true);
  });

  it("mark-player-planted only marks the sender", async () => {
    const { gameCode, bob } = await lobby();
    bob.emit("mark-player-planted", { gameCode, username: "alice" });
    const carol = await newClient();
    const res = await joinAs(carol, gameCode, "carol");
    const byName = Object.fromEntries(res.room!.players.map((p) => [p.username, p]));
    expect(byName.alice.hasPlantedPhoto).toBeFalsy();
    expect(byName.bob.hasPlantedPhoto).toBe(true);
  });
});

// ── Ready ──────────────────────────────────────────────

describe("im-ready", () => {
  it("ignores im-ready from outsiders", async () => {
    const { gameCode, alice, bob } = await lobby();
    await startGame(gameCode, alice, [alice, bob]);
    const outsider = await newClient();
    const quietA = silent(alice, "your-turn", 1_500);
    const quietB = silent(bob, "your-turn", 1_500);
    outsider.emit("im-ready", { gameCode, username: "alice" });
    outsider.emit("im-ready", { gameCode, username: "bob" });
    expect(await quietA).toBe(true);
    expect(await quietB).toBe(true);

    // the real players can still start the round
    const turn = Promise.race([once(alice, "your-turn"), once(bob, "your-turn")]);
    alice.emit("im-ready", { gameCode, username: "alice" });
    bob.emit("im-ready", { gameCode, username: "bob" });
    expect(await turn).toEqual({ round: 1, attempt: 1 });
    for (const c of [alice, bob]) c.emit("leave-room");
  });

  // EXP-010: the ready phase is re-checked when the only missing player goes away (well before READY_TIMEOUT)
  for (const how of ["disconnects", "leaves", "is removed by the host"] as const) {
    it(`starts the first round right away when the only not-ready player ${how}`, async () => {
      const { gameCode, alice, bob } = await lobby();
      const carol = await newClient();
      const carolJoin = await joinAs(carol, gameCode, "carol");
      await startGame(gameCode, alice, [alice, bob, carol]);
      alice.emit("im-ready");
      bob.emit("im-ready");
      expect(await silent(alice, "game-over", QUIET_MS)).toBe(true);

      const turn = Promise.race([once(alice, "your-turn", 3_000), once(bob, "your-turn", 3_000)]);
      if (how === "disconnects") carol.disconnect();
      else if (how === "leaves") carol.emit("leave-room");
      else {
        const carolSocketId = carolJoin.room!.players.find((p) => p.username === "carol")!.socketId as string;
        alice.emit("remove-player", { socketId: carolSocketId });
      }
      expect(await turn).toEqual({ round: 1, attempt: 1 });
      for (const c of [alice, bob]) c.emit("leave-room");
    });
  }

  it("a lone connected ready player does not start (and end) the game; a rejoin + im-ready does", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    await startGame(gameCode, alice, [alice, bob]);
    bob.disconnect(); // backgrounded right after start
    await new Promise((r) => setTimeout(r, 100));
    const noOver = silent(alice, "game-over", 1_500);
    const noTurn = silent(alice, "your-turn", 1_500);
    alice.emit("im-ready");
    expect(await noOver).toBe(true);
    expect(await noTurn).toBe(true);

    const bob2 = await newClient();
    expect((await joinAs(bob2, gameCode, "bob", tokens.bob)).success).toBe(true);
    const turn = Promise.race([once(alice, "your-turn", 3_000), once(bob2, "your-turn", 3_000)]);
    bob2.emit("im-ready");
    expect(await turn).toEqual({ round: 1, attempt: 1 });
    for (const c of [alice, bob2]) c.emit("leave-room");
  });

  it("ignores im-ready before the game started", async () => {
    const { gameCode, alice, bob } = await lobby();
    const quietA = silent(alice, "your-turn", 1_500);
    const quietB = silent(bob, "your-turn", 1_500);
    alice.emit("im-ready", { gameCode, username: "alice" });
    bob.emit("im-ready", { gameCode, username: "bob" });
    expect(await quietA).toBe(true);
    expect(await quietB).toBe(true);
  });
});

// ── Replaced sockets, leaving, kicking ─────────────────

describe("stale sockets and membership changes", () => {
  it("ignores chat, set-rounds and leave-room from a socket replaced by a rejoin", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    // both rejoin on new sockets while the old ones are still connected
    const alice2 = await newClient();
    expect((await joinAs(alice2, gameCode, "alice", tokens.alice)).success).toBe(true);
    const bob2 = await newClient();
    expect((await joinAs(bob2, gameCode, "bob", tokens.bob)).success).toBe(true);

    const quietChat = silent(alice2, "chat-message");
    const quietRounds = silent(bob2, "rounds-updated");
    const quietLeft = silent(alice2, "player-left");
    bob.emit("chat-message", { gameCode, message: "old socket" });
    alice.emit("set-rounds", { gameCode, rounds: 20 });
    bob.emit("leave-room");
    expect(await quietChat).toBe(true);
    expect(await quietRounds).toBe(true);
    expect(await quietLeft).toBe(true);

    // the live sessions still work
    const chat = once<{ username: string; message: string }>(alice2, "chat-message");
    bob2.emit("chat-message", { gameCode, message: "new socket" });
    expect(await chat).toEqual({ username: "bob", message: "new socket" });
  });

  it("lets a player who left the lobby join again with the same name and no token", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    bob.emit("leave-room");
    expect(await left).toBe("bob");
    const again = await newClient();
    const res = await joinAs(again, gameCode, "bob");
    expect(res.success).toBe(true);
    expect(res.rejoinToken).toBeTruthy();
  });

  it("ignores remove-player from a non-host", async () => {
    const { gameCode, alice, bob } = await lobby();
    const quiet = silent(alice, "player-removed");
    bob.emit("remove-player", { gameCode, socketId: alice.id });
    expect(await quiet).toBe(true);
    expect(alice.connected).toBe(true);
  });
});

// ── Photo submission ───────────────────────────────────

describe("photo-sent", () => {
  it("only accepts an upload path from the current owner, and ignores answers from replaced sockets", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    await startGame(gameCode, alice, [alice, bob]);
    const bob2 = await newClient();
    expect((await joinAs(bob2, gameCode, "bob", tokens.bob)).success).toBe(true);

    const turn = Promise.race([
      once(alice, "your-turn").then(() => "alice"),
      once(bob2, "your-turn").then(() => "bob"),
    ]);
    alice.emit("im-ready");
    bob2.emit("im-ready");
    const ownerName = await turn;
    const owner = ownerName === "alice" ? alice : bob2;
    const other = ownerName === "alice" ? bob2 : alice;

    const quiet = silent(alice, "round-start", 500);
    other.emit("photo-sent", { photo: "/temp/0123456789abcdef0123456789abcdef.jpg" });
    bob.emit("photo-sent", { photo: "/temp/0123456789abcdef0123456789abcdef.jpg" }); // replaced socket
    for (const photo of ["https://example.invalid/x.jpg", "/temp/../app.ts", "/temp/1-a/b.jpg", "/temp/1700000000000-photo.jpg", "/temp/0123456789abcdef0123456789abcdef.gif", "/temp/", 42, "/temp/1-" + "a".repeat(2050)]) {
      owner.emit("photo-sent", { photo });
    }
    expect(await quiet).toBe(true);

    const start = once<{ owner: string; photo: string }>(alice, "round-start");
    owner.emit("photo-sent", { photo: "/temp/0123456789abcdef0123456789abcdef.jpg" });
    expect(await start).toMatchObject({ owner: ownerName, photo: "/temp/0123456789abcdef0123456789abcdef.jpg" });

    // answer from the replaced socket is ignored; alice's counts
    bob.emit("submit-answer", { guess: ownerName });
    alice.emit("submit-answer", { guess: ownerName });
    const scores = await once<{ scores: { username: string; lastGuess: string }[] }>(alice, "round-scores", 14_000);
    const byName = Object.fromEntries(scores.scores.map((s) => [s.username, s]));
    expect(byName.bob.lastGuess).toBe("");
    expect(byName.alice.lastGuess).toBe(ownerName);
    for (const c of [alice, bob2]) c.emit("leave-room");
  }, 20_000);
});
