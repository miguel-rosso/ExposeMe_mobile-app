import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { io, server } from "../app";
import { roomManager } from "../routes/socketRoutes";
import { GAME_EVENT_LIMITS } from "../managers/socketGuards";
import { GameEngine } from "../managers/GameEngine";
import { uploadStore } from "../middlewares/uploadStore";
import { registerUpload } from "./helpers";

// EXP-152: plant-photo is acknowledged, so the app counts its planted photo as sent only once the server has it and
// knows whether uploading it again helps. The reasons say nothing about other players (someone else's upload gets
// the same answer as a photo that never existed).

type PlantPhotoAck = { ok: true } | { ok: false; reason: string };

const photo = (c: string) => "/temp/" + c.repeat(32) + ".jpg";
const ACK_WAIT_MS = 2_000;
// Hidden delay of a planted round in the expiry test: long enough to remove the photo before round-start is checked
const EXPIRY_CHECK_DELAY_MS = 300;

let url: string;
const clients: ClientSocket[] = [];

function once<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (data: T) => resolve(data)));
}

async function newClient(): Promise<ClientSocket> {
  const c = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(c);
  await once(c, "connect");
  return c;
}

async function join(c: ClientSocket, gameCode: string | null, username: string): Promise<string> {
  const res = once<{ success: boolean; room: { gameCode: string } }>(c, "room-of-game");
  c.emit("join-create-game", { gameCode, username });
  const data = await res;
  expect(data.success).toBe(true);
  return data.room.gameCode;
}

/** plant-photo with an ack callback: the server's answer, or null if none came in time. */
function plant(c: ClientSocket, payload: unknown): Promise<PlantPhotoAck | null> {
  return c.timeout(ACK_WAIT_MS).emitWithAck("plant-photo", payload).catch(() => null);
}

/** A lobby with alice (host) and bob, each on their own socket. */
async function lobby() {
  const alice = await newClient();
  const gameCode = await join(alice, null, "alice");
  const bob = await newClient();
  await join(bob, gameCode, "bob");
  return { alice, bob, gameCode };
}

/**
 * Bob plants `planted`, the game starts with round 1 as the planted slot, and resolves once round 1 waits for bob's
 * photo. Nobody gets your-turn in a planted wait.
 */
async function startPlantedRound1(alice: ClientSocket, bob: ClientSocket, gameCode: string, planted: string) {
  registerUpload(gameCode, "bob", planted);
  expect(await plant(bob, { photoUrl: planted })).toEqual({ ok: true });
  const slots = vi.spyOn(GameEngine.prototype as any, "assignPlantedSlots")
    .mockImplementation((room: any) => { room.plantedSlots = new Set([1]); });
  const started = once(bob, "game-started");
  alice.emit("start-game");
  await started;
  const plantedWait = once<{ round: number }>(bob, "waiting-photo");
  const turns: unknown[] = [];
  [alice, bob].forEach((c) => c.on("your-turn", (t) => turns.push(t)));
  [alice, bob].forEach((c) => c.emit("im-ready"));
  expect((await plantedWait).round).toBe(1);
  slots.mockRestore();
  expect(turns).toEqual([]);
  expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBeUndefined(); // used by this wait
}

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

describe("plant-photo acknowledgement", () => {
  it("ok once the photo is the player's planted photo", async () => {
    const { bob, gameCode } = await lobby();
    registerUpload(gameCode, "bob", photo("a"));
    expect(await plant(bob, { photoUrl: photo("a") })).toEqual({ ok: true });
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBe(photo("a"));
  });

  it("not-in-room from a socket bound to no room", async () => {
    const stranger = await newClient();
    expect(await plant(stranger, { photoUrl: photo("b") })).toEqual({ ok: false, reason: "not-in-room" });
  });

  it("invalid for a payload that is no upload path", async () => {
    const { bob, gameCode } = await lobby();
    for (const payload of [{ photoUrl: "https://example.invalid/x.jpg" }, { photoUrl: 42 }, {}, null]) {
      expect(await plant(bob, payload)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBeUndefined();
  });

  it("photo-unavailable for an expired/deleted upload and for another player's one alike", async () => {
    const { bob, gameCode } = await lobby();
    registerUpload(gameCode, "alice", photo("c"));
    const othersPhoto = await plant(bob, { photoUrl: photo("c") });
    const missingPhoto = await plant(bob, { photoUrl: photo("d") }); // never uploaded, or already deleted
    expect(othersPhoto).toEqual({ ok: false, reason: "photo-unavailable" });
    expect(missingPhoto).toEqual(othersPhoto);
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBeUndefined();
  });

  it("too-late once round 1 is played, before looking at the photo", async () => {
    const { bob, gameCode } = await lobby();
    registerUpload(gameCode, "bob", photo("e"));
    const room = roomManager.getRoom(gameCode)!;
    Object.assign(room, { started: true, phase: "answering", round: 1 });
    expect(await plant(bob, { photoUrl: photo("e") })).toEqual({ ok: false, reason: "too-late" });
    // Also for a photo it doesn't have: uploading it again would not help
    expect(await plant(bob, { photoUrl: photo("f") })).toEqual({ ok: false, reason: "too-late" });
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBeUndefined();
  });

  // A plant-photo accepted but whose ack was lost counts as not sent in the app, which plants the photo again (after
  // im-ready or a rejoin). While round 1 waits for that very photo its mark is already cleared: the server must not
  // take the same image again, or it would get a later round and be shown twice.
  it("too-late for the planter while their planted photo is the one awaited; others may still plant", async () => {
    const { alice, bob, gameCode } = await lobby();
    await startPlantedRound1(alice, bob, gameCode, photo("1"));
    const room = roomManager.getRoom(gameCode)!;
    const slotsBefore = [...room.plantedSlots];

    registerUpload(gameCode, "bob", photo("2")); // the same image uploaded again by the app's retry
    expect(await plant(bob, { photoUrl: photo("2") })).toEqual({ ok: false, reason: "too-late" });
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBeUndefined();
    expect([...room.plantedSlots]).toEqual(slotsBefore);

    // Not a general round-1 refusal: another player's late planted photo is still taken
    registerUpload(gameCode, "alice", photo("3"));
    expect(await plant(alice, { photoUrl: photo("3") })).toEqual({ ok: true });
  }, 10_000);

  // The planted photo expired while round 1 waited for it (e.g. a long pause): that round will be skipped like an
  // owner who never sends, so the planter's re-planted copy is a new photo for a later round, not a duplicate.
  it("ok for the planter once their awaited planted photo expired; it gets a later round", async () => {
    const { alice, bob, gameCode } = await lobby();
    const room = roomManager.getRoom(gameCode)!;
    const delay = vi.spyOn(GameEngine.prototype as any, "plantedDelay").mockReturnValue(EXPIRY_CHECK_DELAY_MS);
    const expiryCheck = vi.spyOn(GameEngine.prototype as any, "startPlantedRound");
    await startPlantedRound1(alice, bob, gameCode, photo("4"));
    delay.mockRestore();
    uploadStore.remove(photo("4")); // expired before round-start
    // This room's check only: the engine is shared, and earlier tests' rooms still run their own planted rounds
    const checkedThisRoom = () => expiryCheck.mock.calls.some(([checked]) => checked === room);
    await vi.waitFor(() => expect(checkedThisRoom()).toBe(true), { timeout: ACK_WAIT_MS });
    expiryCheck.mockRestore();
    expect(room.phase).toBe("waiting-photo"); // no round-start: the wait now runs out and the round is skipped

    registerUpload(gameCode, "bob", photo("5"));
    expect(await plant(bob, { photoUrl: photo("5") })).toEqual({ ok: true });
    expect(roomManager.getPlayer(gameCode, "bob")?.plantedPhoto).toBe(photo("5"));
    expect([...room.plantedSlots].some((r) => r > 1)).toBe(true);
  }, 10_000);

  it("no ack for an event dropped by the rate limit", async () => {
    const { bob } = await lobby();
    const answers = await Promise.all(
      Array.from({ length: GAME_EVENT_LIMITS["plant-photo"].burst + 1 }, () => plant(bob, { photoUrl: photo("0") })),
    );
    expect(answers.slice(0, -1).every((a) => a?.ok === false)).toBe(true);
    expect(answers[answers.length - 1]).toBeNull();
  });
});
