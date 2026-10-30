import { describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { registerTurnUpload, registerUpload } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-017 / EXP-027: real server + real clients. Records every event each client receives and checks that no
// payload carries a socket id, a rejoin token (other than the receiver's own, in room-of-game) or a planted photo
// URL (except as the photo of the round that plays it), and that the answers of the round in play are hidden
// (room-of-game / game-state / new-host) until round-scores. Also covers remove-player by username.

const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg";
const PLANTED = "/temp/fedcba9876543210fedcba9876543210.jpg";
const FORBIDDEN_KEYS = new Set(["socketId", "rejoinToken", "plantedPhoto", "hasPlantedPhoto", "isReady"]);
// Fixed Math.random for the game's draws: among [alice, bob, carol] it picks bob as round 1's owner, and the
// planted-slot shuffle of a 10-round game puts bob's planted photo in round 10, so round 1 is an uploaded photo.
const RANDOM_BOB_OWNS_ROUND_1 = 0.4;

interface Received { who: string; ev: string; args: unknown[] }

const harness = useTestServer();
const { once, joinAs } = harness;
// Own record (not the harness's recordPayloads): each event is tagged with the player who received it
const received: Received[] = [];
const socketIds = new Set<string>();
const tokens = new Map<string, string>(); // username -> rejoinToken

async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function newClient(who: string): Promise<ClientSocket> {
  const c = harness.connectClient();
  c.onAny((ev: string, ...args: unknown[]) => received.push({ who, ev, args }));
  await once(c, "connect");
  socketIds.add(c.id!);
  return c;
}

async function join(c: ClientSocket, gameCode: string | null, username: string, rejoinToken?: string) {
  const data = await joinAs(c, gameCode, username, rejoinToken);
  expect(data.success).toBe(true);
  tokens.set(username, data.rejoinToken!);
  return { ...data, room: data.room! };
}

/** Problems found in one received payload (path-qualified). */
function leaks(r: Received): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (typeof v === "string") {
      if (socketIds.has(v)) out.push(`${r.who} ${r.ev} ${path.join(".")}: socket id`);
      for (const [name, tok] of tokens) if (v === tok && !(r.ev === "room-of-game" && path.join(".") === "0.rejoinToken" && name === r.who)) out.push(`${r.who} ${r.ev} ${path.join(".")}: token of ${name}`);
      if (v === PLANTED && path[path.length - 1] !== "photo") out.push(`${r.who} ${r.ev} ${path.join(".")}: planted photo URL`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)]));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        // room-of-game carries the receiver's own token and planted mark (EXP-126), at the top level only
        const isOwnToken = r.ev === "room-of-game" && path.length === 1 && (k === "rejoinToken" || k === "hasPlantedPhoto");
        if (FORBIDDEN_KEYS.has(k) && !isOwnToken) out.push(`${r.who} ${r.ev} ${[...path, k].join(".")}: forbidden key`);
        walk(x, [...path, k]);
      }
    }
  };
  walk(r.args, []);
  return out;
}

describe("player data in socket payloads", () => {
  it("never leaks socket ids, tokens or planted photos, and hides the round's answers until round-scores", async () => {
    const alice = await newClient("alice");
    const { room } = await join(alice, null, "alice");
    const gameCode = room.gameCode;
    const byName: Record<string, ClientSocket> = { alice };
    for (const name of ["bob", "carol", "dave"]) {
      byName[name] = await newClient(name);
      await join(byName[name], gameCode, name);
    }

    // bob plants a photo: it is drawn for a later round, so it must not leak while round 1 plays
    registerUpload(gameCode, "bob", PLANTED);
    byName.bob.emit("plant-photo", { photoUrl: PLANTED });

    // Host kicks dave by username; kicking itself is ignored
    alice.emit("remove-player", { username: "alice" });
    const removed = once<Record<string, unknown>>(byName.bob, "player-removed");
    const kicked = once(byName.dave, "disconnect");
    alice.emit("remove-player", { username: "dave" });
    expect((await removed).username).toBe("dave");
    await kicked;
    expect(roomManager.getRoom(gameCode)!.players.map((p) => p.username)).toEqual(["alice", "bob", "carol"]);

    // game-started: only the allowlisted player fields
    const players = ["alice", "bob", "carol"];
    const started = players.map((n) => once<Record<string, unknown>[]>(byName[n], "game-started"));
    vi.spyOn(Math, "random").mockReturnValue(RANDOM_BOB_OWNS_ROUND_1);
    alice.emit("start-game");
    const startedPlayers = await started[0];
    await Promise.all(started);
    expect(startedPlayers.map((p) => Object.keys(p).sort())).toEqual(players.map(() => ["connected", "isHost", "lastAnswerCorrect", "lastGuess", "points", "username"]));

    // First round: an uploaded photo from bob, the picked owner (round-start never names the owner, EXP-128: it
    // is whoever got your-turn)
    let turnOwner: string | null = null;
    for (const n of players) {
      byName[n].once("your-turn", (turn: { round: number }) => {
        turnOwner = n;
        registerTurnUpload(gameCode, n, PHOTO, turn.round);
        byName[n].emit("photo-sent", { photo: PHOTO });
      });
    }
    const roundStart = once<{ photo: string }>(alice, "round-start", 6_000);
    players.forEach((n) => byName[n].emit("im-ready"));
    expect((await roundStart).photo).toBe(PHOTO);
    const owner = "bob";
    expect(turnOwner).toBe(owner);

    // bob (host once alice leaves) answers during answering: the owner guesses and scores like anyone (EXP-252),
    // so naming himself is a right answer — the one answer that would give the owner away if it leaked...
    const guesser = owner;
    byName[guesser].emit("submit-answer", { guess: owner });
    await until(() => roomManager.getPlayer(gameCode, guesser)?.lastGuess === owner);
    expect(roomManager.getPlayer(gameCode, guesser)).toMatchObject({ points: 1, lastAnswerCorrect: true });

    // ...and reconnects on a new socket: room-of-game and game-state hide that answer until round-scores
    const again = await newClient(guesser);
    const snap = once<{ phase: string; players: Record<string, unknown>[]; scores: Record<string, unknown>[] }>(again, "game-state");
    const rejoined = await join(again, gameCode, guesser, tokens.get(guesser));
    const hidden = { points: 0, lastGuess: "", lastAnswerCorrect: false };
    expect(rejoined.room.players.find((p) => p.username === guesser)).toMatchObject(hidden);
    expect(rejoined.room).not.toHaveProperty("currentPlayer");
    const state = await snap;
    expect(state.phase).toBe("answering");
    expect(state.players.find((p) => p.username === guesser)).toMatchObject(hidden);
    expect(state.scores.find((s) => s.username === guesser)).toMatchObject(hidden);

    // The host leaves mid-answering: bob becomes host, and new-host hides his answer too
    const newHost = once<Record<string, unknown>>(byName.carol, "new-host");
    alice.emit("leave-room");
    const host = await newHost;
    expect(host).toMatchObject({ username: guesser, ...hidden });

    const problems = received.flatMap(leaks);
    expect(problems).toEqual([]);
    expect(received.some((r) => r.ev === "room-of-game")).toBe(true);
  }, 20_000);
});
