import { EventEmitter } from "events";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  uploadPlayerRateLimit,
  uploadRoomRateLimit,
  UPLOAD_PLAYER_RATE_MAX,
  UPLOAD_ROOM_RATE_MAX,
} from "../middlewares/rateLimit";
import { createInFlightLimiter } from "../middlewares/uploadInFlight";

// EXP-153: a member who leaves and rejoins under other names must not get a fresh share of the room's upload budget
// (nor hand their spent quota to whoever takes their old name next).

vi.hoisted(() => {
  // Defaults, even if the shell exports a lab override
  for (const name of ["UPLOAD_RATE_WINDOW_MS", "UPLOAD_PLAYER_RATE_MAX", "UPLOAD_ROOM_RATE_MAX"]) delete process.env[name];
});

interface FakeRoom { gameCode: string; started: boolean }

let rooms = 0;
const newRoom = (): FakeRoom => ({ gameCode: `ROOM${++rooms}`, started: false });
const newPlayer = (username: string) => ({ username });

/** Runs one upload through the per-member and per-room limits, as uploadRoutes chains them. */
function upload(room: FakeRoom, player: { username: string }): number {
  let status = 200;
  const res = {
    locals: { member: { room, player } },
    setHeader: () => undefined,
    status(code: number) { status = code; return res; },
    json: () => res,
  } as unknown as Response;
  const req = {} as Request;
  let passed = false;
  uploadPlayerRateLimit(req, res, (() => {
    uploadRoomRateLimit(req, res, (() => { passed = true; }) as NextFunction);
  }) as NextFunction);
  return passed ? 200 : status;
}

const uploadMany = (room: FakeRoom, player: { username: string }, n: number) =>
  Array.from({ length: n }, () => upload(room, player));

describe("POST /upload member and room limits (EXP-153)", () => {
  it("a new player under a departed player's name starts with their own quota", () => {
    const room = newRoom();
    expect(uploadMany(room, newPlayer("ana"), UPLOAD_PLAYER_RATE_MAX).every((s) => s === 200)).toBe(true);
    // Same name, but a different seat (the first "ana" left and someone else joined as "ana")
    expect(upload(room, newPlayer("ana"))).toBe(200);
  });

  it("the same seat keeps its quota (a rejoin keeps the Player object; see uploadRateLimits.integration)", () => {
    const room = newRoom();
    const ana = newPlayer("ana");
    uploadMany(room, ana, UPLOAD_PLAYER_RATE_MAX);
    expect(upload(room, ana)).toBe(429);
  });

  it("lobby uploads under ever new names never use up the room budget", () => {
    const room = newRoom();
    const churnedNames = Math.ceil(UPLOAD_ROOM_RATE_MAX / UPLOAD_PLAYER_RATE_MAX) + 1;
    for (let i = 0; i < churnedNames; i++) uploadMany(room, newPlayer(`alias${i}`), UPLOAD_PLAYER_RATE_MAX);
    expect(upload(room, newPlayer("bea"))).toBe(200);
  });

  it("once the game has started (no new names can join) the room budget applies, lobby uploads not counted", () => {
    const room = newRoom();
    const players = Array.from({ length: 13 }, (_, i) => newPlayer(`p${i}`));
    uploadMany(room, players[0], UPLOAD_PLAYER_RATE_MAX); // lobby
    room.started = true;
    let accepted = 0;
    for (const p of players.slice(1)) accepted += uploadMany(room, p, UPLOAD_PLAYER_RATE_MAX).filter((s) => s === 200).length;
    expect(accepted).toBe(UPLOAD_ROOM_RATE_MAX);
  });
});

describe("POST /upload per-member in-flight cap (EXP-153)", () => {
  const limiter = () => createInFlightLimiter({ max: 100, perIpMax: 100, perRoomMax: 100, perMemberMax: 1, timeoutMs: 60_000 });

  /** Starts an upload (left in flight) and returns its status: 200 if admitted. */
  function start(mw: ReturnType<typeof limiter>, room: FakeRoom, player: { username: string }) {
    let status = 200;
    const res = Object.assign(new EventEmitter(), {
      locals: { member: { room, player } },
      setHeader: () => undefined,
      status(code: number) { status = code; return res; },
      json: () => res,
    });
    const req = Object.assign(new EventEmitter(), {
      ip: "198.51.100.7", socket: {}, complete: false, pause() {}, resume() {},
    }) as unknown as Request;
    const next = vi.fn();
    mw(req, res as unknown as Response, next);
    return next.mock.calls.length === 1 ? 200 : status;
  }

  it("a new player under a departed player's name isn't blocked by that player's uploads still in flight", () => {
    const mw = limiter();
    const room = newRoom();
    const departed = newPlayer("ana");
    expect(start(mw, room, departed)).toBe(200);
    expect(start(mw, room, departed)).toBe(429);
    expect(start(mw, room, newPlayer("ana"))).toBe(200);
  });
});
