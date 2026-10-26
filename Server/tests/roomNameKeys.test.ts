import { beforeEach, describe, expect, it, vi } from "vitest";
import * as playerName from "../managers/playerName";
import { MAX_PLAYERS_PER_ROOM, RoomManager } from "../managers/RoomManager";

// EXP-032: a join computes the keys of the new name only; each player's keys are computed once and reused.
vi.mock("../managers/playerName", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managers/playerName")>();
  return { ...actual, nameKeys: vi.fn(actual.nameKeys) };
});

const nameKeys = vi.mocked(playerName.nameKeys);

describe("name keys per join", () => {
  let rm: RoomManager;
  beforeEach(() => {
    rm = new RoomManager();
    nameKeys.mockClear();
  });

  it("computes only the joining name's keys: each player keeps the keys computed when they joined", () => {
    const room = rm.createRoom("host", "sock-0");
    for (let i = 1; i <= MAX_PLAYERS_PER_ROOM - 2; i++) rm.joinRoom(room.gameCode, `player${i}`, `sock-${i}`);
    nameKeys.mockClear();
    const attempts = ["Host", "PLAYER1", "pIayer2", "Host", "PLAYER1", "pIayer2"];
    for (const name of attempts) rm.joinRoom(room.gameCode, name, `sock-${name}`);

    const computed = nameKeys.mock.calls.map(([name]) => name);
    expect(computed).toEqual(attempts);
  });
});
