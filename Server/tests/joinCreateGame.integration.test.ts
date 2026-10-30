import { describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import type { RoomOfGameResponse } from "../models/interfaces";
import { roomManager } from "../routes/socketRoutes";
import { plantPhoto } from "./helpers";
import { useTestServer } from "./socketHarness";

// EXP-246: every answer join-create-game sends (create, join, rejoin, same-socket re-join, each refusal), with its
// exact top-level keys, and how the socket is bound afterwards. A successful answer is always
// `{ success, room, rejoinToken, hasPlantedPhoto }` (no top-level `rounds`: the room carries it), a refusal
// `{ success: false, message }`.

const JOINED_KEYS = ["hasPlantedPhoto", "rejoinToken", "room", "success"];
const ROOM_KEYS = ["gameCode", "held", "paused", "phase", "players", "round", "rounds", "started"];
const PHOTO = "/temp/" + "b".repeat(32) + ".jpg";

const { once, silent, newClient, joinAs, lobby, startGame } = useTestServer({ resetBetweenTests: true });

/** A successful answer: exactly the joined keys, the public room, and the player's own token and planted mark. */
function expectJoined(res: RoomOfGameResponse, gameCode: string, hasPlantedPhoto = false): void {
  expect(Object.keys(res).sort()).toEqual(JOINED_KEYS);
  expect(res.success).toBe(true);
  expect(Object.keys(res.room!).sort()).toEqual(ROOM_KEYS);
  expect(res.room!.gameCode).toBe(gameCode);
  expect(res.rejoinToken).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  expect(res.hasPlantedPhoto).toBe(hasPlantedPhoto);
}

/** A newcomer joins `gameCode` as `name`: `sock` gets its player-joined, i.e. it is in that socket.io room. */
async function expectInRoomBroadcasts(sock: ClientSocket, gameCode: string, name: string): Promise<void> {
  const announced = once<{ username: string }>(sock, "player-joined");
  expectJoined(await joinAs(await newClient(), gameCode, name), gameCode);
  expect((await announced).username).toBe(name);
}

/** A newcomer joins `gameCode` as `name`: `sock` gets no player-joined, i.e. it is out of that socket.io room. */
async function expectOutOfRoomBroadcasts(sock: ClientSocket, gameCode: string, name: string): Promise<void> {
  const quiet = silent(sock, "player-joined");
  expectJoined(await joinAs(await newClient(), gameCode, name), gameCode);
  expect(await quiet).toBe(true);
}

// ── Successful answers ─────────────────────────────────

describe("join-create-game successful answers", () => {
  it("create: a new room hosted by the creator, its token, not planted", async () => {
    const alice = await newClient();
    const res = await joinAs(alice, null, "alice");
    expectJoined(res, res.room!.gameCode);
    expect(res.room!.players).toEqual([expect.objectContaining({ username: "alice", isHost: true })]);
    expect(roomManager.getPlayer(res.room!.gameCode, "alice")!.rejoinToken).toBe(res.rejoinToken);
  });

  it("create with an empty code also creates a room", async () => {
    const res = await joinAs(await newClient(), "", "alice");
    expectJoined(res, res.room!.gameCode);
  });

  it("join: the joiner's answer, player-joined to the others only", async () => {
    const alice = await newClient();
    const gameCode = (await joinAs(alice, null, "alice")).room!.gameCode;
    const bob = await newClient();
    const announced = once<{ username: string }>(alice, "player-joined");
    const bobNotAnnounced = silent(bob, "player-joined");
    const res = await joinAs(bob, gameCode.toLowerCase(), "bob");
    expectJoined(res, gameCode);
    expect(res.room!.players.map((p) => p.username)).toEqual(["alice", "bob"]);
    expect((await announced).username).toBe("bob");
    expect(await bobNotAnnounced).toBe(true);
  });

  it("rejoin on a new socket: same token, own planted mark, old socket evicted, no player-joined", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    plantPhoto(gameCode, roomManager.getPlayer(gameCode, "bob")!, PHOTO);
    const oldGone = once(bob, "disconnect");
    const noAnnounce = silent(alice, "player-joined");
    const res = await joinAs(await newClient(), gameCode, "bob", tokens.bob);
    expectJoined(res, gameCode, true);
    expect(res.rejoinToken).toBe(tokens.bob);
    await oldGone;
    expect(await noAnnounce).toBe(true);
  });

  it("rejoin mid-game on a new socket: the answer, then the game-state snapshot", async () => {
    const { gameCode, alice, bob, tokens } = await lobby();
    await startGame(alice, [alice, bob]);
    const bob2 = await newClient();
    const snapshot = once(bob2, "game-state");
    const res = await joinAs(bob2, gameCode, "bob", tokens.bob);
    expectJoined(res, gameCode);
    expect(res.room!.started).toBe(true);
    await snapshot;
  });

  it("same socket, same room and name: the same answer again, still one player", async () => {
    const { gameCode, alice, tokens } = await lobby();
    plantPhoto(gameCode, roomManager.getPlayer(gameCode, "alice")!, PHOTO);
    const res = await joinAs(alice, gameCode, "alice");
    expectJoined(res, gameCode, true);
    expect(res.rejoinToken).toBe(tokens.alice);
    expect(res.room!.players.map((p) => p.username)).toEqual(["alice", "bob"]);
  });

  it("same socket mid-game: the answer plus the game state again", async () => {
    const { gameCode, alice, bob } = await lobby();
    await startGame(alice, [alice, bob]);
    const snapshot = once(bob, "game-state");
    const res = await joinAs(bob, gameCode, "bob");
    expectJoined(res, gameCode);
    await snapshot;
  });

  it("same room under another name: the old name's slot is freed", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    const res = await joinAs(bob, gameCode, "robert");
    expectJoined(res, gameCode);
    expect(await left).toBe("bob");
    expect(roomManager.getRoom(gameCode)!.players.map((p) => p.username)).toEqual(["alice", "robert"]);
    // Leaving the old name must not take the socket out of the room it stays in
    await expectInRoomBroadcasts(bob, gameCode, "dave");
  });

  it("another room: the previous room is left only once the new join succeeds", async () => {
    const { gameCode, alice, bob } = await lobby();
    const other = (await joinAs(await newClient(), null, "carol")).room!.gameCode;
    const left = once<string>(alice, "player-left");
    const res = await joinAs(bob, other, "bob");
    expectJoined(res, other);
    expect(await left).toBe("bob");
    expect(roomManager.getPlayer(gameCode, "bob")).toBeUndefined();
    await expectInRoomBroadcasts(bob, other, "dave");
    await expectOutOfRoomBroadcasts(bob, gameCode, "erin");
  });

  it("creating a room from a lobby leaves that lobby", async () => {
    const { gameCode, alice, bob } = await lobby();
    const left = once<string>(alice, "player-left");
    const res = await joinAs(bob, null, "bob");
    expectJoined(res, res.room!.gameCode);
    expect(res.room!.gameCode).not.toBe(gameCode);
    expect(await left).toBe("bob");
  });
});

// ── Refusals ───────────────────────────────────────────

describe("join-create-game refusals", () => {
  it("invalid username", async () => {
    expect(await joinAs(await newClient(), null, "")).toEqual({ success: false, message: "Invalid username" });
    expect(await joinAs(await newClient(), null, 42)).toEqual({ success: false, message: "Invalid username" });
  });

  it("a non-string code, a malformed code and an unknown code: Game not found", async () => {
    expect(await joinAs(await newClient(), 123, "dave")).toEqual({ success: false, message: "Game not found" });
    expect(await joinAs(await newClient(), "nope!", "dave")).toEqual({ success: false, message: "Game not found" });
    expect(await joinAs(await newClient(), "ZZZZZZ", "dave")).toEqual({ success: false, message: "Game not found" });
  });

  it("a second unknown code on the same socket within its miss cooldown: Too many attempts", async () => {
    const c = await newClient();
    expect(await joinAs(c, "ZZZZZZ", "dave")).toEqual({ success: false, message: "Game not found" });
    expect(await joinAs(c, "ZZZZZY", "dave")).toEqual({ success: false, message: "Too many attempts" });
  });

  it("more than 5 joins in 10 s on one socket: Too many attempts", async () => {
    const c = await newClient();
    for (let i = 0; i < 5; i++) expect((await joinAs(c, null, "")).message).toBe("Invalid username");
    expect(await joinAs(c, null, "dave")).toEqual({ success: false, message: "Too many attempts" });
  });

  it("RoomManager.joinRoom's refusal message, and the socket stays where it was", async () => {
    const { gameCode, alice, bob } = await lobby();
    const other = (await joinAs(await newClient(), null, "bob")).room!.gameCode;
    const noLeave = silent(alice, "player-left");
    expect(await joinAs(bob, other, "bob")).toEqual({ success: false, message: "Username already taken" });
    expect(await noLeave).toBe(true);
    expect(roomManager.getPlayer(gameCode, "bob")!.connected).toBe(true);
    // Still bound to its room: the same-socket re-join answers as before
    expectJoined(await joinAs(bob, gameCode, "bob"), gameCode);
  });

  it("a wrong token for an existing name in another room: refused, and the socket stays in its room", async () => {
    const { gameCode, alice, bob } = await lobby();
    const otherCode = (await joinAs(await newClient(), null, "carol")).room!.gameCode;
    const noLeave = silent(alice, "player-left");
    expect(await joinAs(bob, otherCode, "carol", "x".repeat(24))).toEqual({ success: false, message: "Username already taken" });
    expect(await noLeave).toBe(true);
    expect(roomManager.getPlayer(gameCode, "bob")!.connected).toBe(true);
    expect(roomManager.getRoom(otherCode)!.players.map((p) => p.username)).toEqual(["carol"]);
    await expectInRoomBroadcasts(bob, gameCode, "dave");
  });

  it("a started game: Game already started", async () => {
    const { gameCode, alice, bob } = await lobby();
    await startGame(alice, [alice, bob]);
    expect(await joinAs(await newClient(), gameCode, "dave")).toEqual({ success: false, message: "Game already started" });
  });

  it("no room can be created at capacity: Server is busy", async () => {
    const atCapacity = vi.spyOn(roomManager, "isAtCapacity").mockReturnValue(true);
    try {
      expect(await joinAs(await newClient(), null, "dave")).toEqual({ success: false, message: "Server is busy" });
    } finally {
      atCapacity.mockRestore();
    }
  });
});
