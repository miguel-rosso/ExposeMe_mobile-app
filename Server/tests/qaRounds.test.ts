import { afterEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { isAllowedRounds } from "../managers/RoomManager";
import { useTestServer } from "./socketHarness";

// EXP-100: 3-round games exist only for QA (short device runs). The server accepts them only with ALLOW_QA_ROUNDS=1
// (set by qa/lab/lab.sh server); production runs without it and keeps 10/15/20.

describe("isAllowedRounds", () => {
  it("accepts 10/15/20 with or without the QA flag", () => {
    for (const r of [10, 15, 20]) {
      expect(isAllowedRounds(r, {})).toBe(true);
      expect(isAllowedRounds(r, { ALLOW_QA_ROUNDS: "1" })).toBe(true);
    }
  });

  it("rejects 3 rounds unless ALLOW_QA_ROUNDS=1", () => {
    expect(isAllowedRounds(3, {})).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "0" })).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "true" })).toBe(false);
    expect(isAllowedRounds(3, { ALLOW_QA_ROUNDS: "1" })).toBe(true);
  });

  it("rejects anything else even with the QA flag", () => {
    for (const r of [0, 1, 2, 4, 5, 11, 100, -3, NaN, "3", null, undefined]) {
      expect(isAllowedRounds(r, { ALLOW_QA_ROUNDS: "1" })).toBe(false);
    }
  });
});

// ── set-rounds over a real socket ──

const { once, silent, newClient, joinAs } = useTestServer();

async function hostLobby(): Promise<ClientSocket> {
  const c = await newClient();
  await joinAs(c, null, "host");
  return c;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("set-rounds", () => {
  it("ignores rounds: 3 when the server runs without ALLOW_QA_ROUNDS", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "");
    const host = await hostLobby();
    const quiet = silent(host, "rounds-updated");
    host.emit("set-rounds", { rounds: 3 });
    expect(await quiet).toBe(true);
  });

  it("accepts rounds: 3 when ALLOW_QA_ROUNDS=1", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "1");
    const host = await hostLobby();
    const updated = once<number>(host, "rounds-updated");
    host.emit("set-rounds", { rounds: 3 });
    expect(await updated).toBe(3);
  });

  it("still accepts 10/15/20 without the flag", async () => {
    vi.stubEnv("ALLOW_QA_ROUNDS", "");
    const host = await hostLobby();
    for (const r of [15, 20, 10]) {
      const updated = once<number>(host, "rounds-updated");
      host.emit("set-rounds", { rounds: r });
      expect(await updated).toBe(r);
    }
  });
});
