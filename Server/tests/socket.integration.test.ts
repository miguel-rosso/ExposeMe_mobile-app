import { describe, expect, it } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { roomManager } from "../routes/socketRoutes";
import { registerTurnUpload } from "./helpers";
import { useTestServer } from "./socketHarness";
import { ANSWER_GRACE, ANSWER_TIME } from "../managers/GameEngine";

// Real server on an ephemeral port + 3 real socket.io clients.
// Production timings are kept; this only covers lobby → first round-start (~1s, GAME_START_DELAY).

const PHOTO = "/temp/0123456789abcdef0123456789abcdef.jpg"; // shape of a POST /upload result

const { once, newClient } = useTestServer();

describe("socket flow", () => {
  it("join → start → im-ready → your-turn → photo-sent → round-start reaches all clients", async () => {
    const [alice, bob, carol] = [await newClient(), await newClient(), await newClient()];
    const byName: Record<string, ClientSocket> = { alice, bob, carol };

    // Create
    const created = once<{ success: boolean; room: { gameCode: string } }>(alice, "room-of-game");
    alice.emit("join-create-game", { gameCode: null, username: "alice" });
    const { room } = await created;
    const gameCode = room.gameCode;
    expect(gameCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

    // Join
    for (const [name, sock] of [["bob", bob], ["carol", carol]] as const) {
      const joined = once<{ success: boolean; room: { players: { username: string }[] } }>(sock, "room-of-game");
      const announced = once<{ username: string }>(alice, "player-joined");
      sock.emit("join-create-game", { gameCode, username: name });
      expect((await joined).success).toBe(true);
      expect((await announced).username).toBe(name);
    }

    // Start
    const started = [alice, bob, carol].map((c) => once<unknown[]>(c, "game-started"));
    alice.emit("start-game");
    await Promise.all(started);

    // Ready → exactly one player gets your-turn
    const turn = new Promise<{ name: string; data: { round: number } }>((resolve) => {
      for (const [name, sock] of Object.entries(byName)) sock.once("your-turn", (data) => resolve({ name, data }));
    });
    for (const sock of Object.values(byName)) sock.emit("im-ready");
    const { name: owner, data: turnData } = await turn;
    expect(turnData).toEqual({ round: 1, attempt: 1 });

    // Photo → round-start broadcast to everyone
    const roundStarts = [alice, bob, carol].map((c) => once<Record<string, unknown>>(c, "round-start"));
    registerTurnUpload(gameCode, owner, PHOTO, 1); // as if the owner had uploaded it (photo-sent takes only own uploads)
    byName[owner].emit("photo-sent", { photo: PHOTO });
    const payloads = await Promise.all(roundStarts);
    // Same payload for everyone, owner included: nobody is told whose photo it is (EXP-128, EXP-252)
    payloads.forEach((p) => expect(p).toEqual({ photo: PHOTO, round: 1, duration: ANSWER_TIME - ANSWER_GRACE }));

    // Everybody leaves → room reset (its deletion timer is cleared in afterAll)
    for (const c of [alice, bob, carol]) c.emit("leave-room");
  });

  it("teardown (roomManager.clear) leaves no rooms and no pending deletion timers", async () => {
    const c = await newClient();
    const created = once(c, "room-of-game");
    c.emit("join-create-game", { gameCode: null, username: "dave" });
    await created;
    c.emit("leave-room"); // empty room → deletion scheduled
    // Events of one socket are handled in order: this answer means leave-room was processed
    const probe = once<{ success: boolean }>(c, "room-of-game");
    c.emit("join-create-game", { gameCode: "000000", username: "dave" });
    expect((await probe).success).toBe(false);
    expect(roomManager.stats().pendingDeletions).toBeGreaterThan(0);

    roomManager.clear();
    expect(roomManager.stats()).toEqual({ rooms: 0, pendingDeletions: 0 });
  });
});
