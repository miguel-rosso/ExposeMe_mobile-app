import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatMessages, joinAttempts, roomManager } from "../routes/socketRoutes";
import { GameEngine } from "../managers/GameEngine";
import { useTestServer } from "./socketHarness";

// EXP-216: the per-socket limits of join-create-game (5 in any 10 s), chat-message (one every 250 ms) and
// submit-answer (burst 10, refilled 5/s), pinned with explicit numbers so they stay the same whatever mechanism
// enforces them; and the chat limit's per-socket state, which must not outlive the socket (EXP-159).
// Date is frozen for each test (before its sockets connect) and moved with vi.setSystemTime.

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

// Every test plays in a lobby of its own (or in none), so each one's rooms and sockets are dropped after it
const { once, newClient, joinAs } = useTestServer({ resetBetweenTests: true });

/** A lobby with a host and a guest, each on its own socket (one join spent on each). */
async function lobby() {
  const host = await newClient();
  const guest = await newClient();
  const { room } = await joinAs(host, null, "host");
  const gameCode = room!.gameCode;
  expect((await joinAs(guest, gameCode, "guest")).success).toBe(true);
  return { host, guest, gameCode };
}

const at = (ms: number) => vi.setSystemTime(T0 + ms);

/** Polls `check` on real timers until it is true, leaving the frozen Date alone (vi.waitFor would advance it). */
async function untilFrozen(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("join-create-game: at most 5 per socket in any 10 s", () => {
  it("answers the 6th 'Too many attempts' until the oldest attempt is 10 s old", async () => {
    const sock = await newClient();
    const { room } = await joinAs(sock, null, "host");
    // Re-sending the join it already has is a no-op answered success, and still an attempt
    for (let i = 0; i < 4; i++) {
      at(i + 1);
      expect((await joinAs(sock, room!.gameCode, "host")).success).toBe(true);
    }
    at(9_999);
    expect(await joinAs(sock, room!.gameCode, "host")).toEqual({ success: false, message: "Too many attempts" });
    at(10_000); // the first attempt (at 0) left the window; a refused one never counted
    expect((await joinAs(sock, room!.gameCode, "host")).success).toBe(true);
    expect(await joinAs(sock, room!.gameCode, "host")).toEqual({ success: false, message: "Too many attempts" });
  });

  it("counts per socket: another socket on the same IP still gets through", async () => {
    const a = await newClient();
    const { room } = await joinAs(a, null, "host");
    for (let i = 0; i < 4; i++) await joinAs(a, room!.gameCode, "host");
    expect((await joinAs(a, room!.gameCode, "host")).message).toBe("Too many attempts");
    const b = await newClient();
    expect((await joinAs(b, room!.gameCode, "guest")).success).toBe(true);
  });
});

describe("chat-message: one per socket every 250 ms", () => {
  it("drops messages less than 250 ms after the last one relayed (a dropped one doesn't restart the wait)", async () => {
    const { host, guest, gameCode } = await lobby();
    const received: string[] = [];
    guest.on("chat-message", ({ message }: { message: string }) => received.push(message));
    /** The join it already has: answered once every earlier event of the host has been handled. */
    const handled = async () => expect((await joinAs(host, gameCode, "host")).success).toBe(true);
    /** Sends `message` and waits until the guest gets it (relayed in order with the host's earlier messages). */
    const relayed = async (message: string) => {
      const got = once(guest, "chat-message");
      host.emit("chat-message", { message });
      await got;
    };

    await relayed("first");
    host.emit("chat-message", { message: "same instant" });
    await handled();
    at(249);
    host.emit("chat-message", { message: "249 ms" });
    await handled();
    at(250);
    await relayed("250 ms");
    at(499);
    host.emit("chat-message", { message: "499 ms" });
    await handled();
    at(500);
    await relayed("500 ms");
    expect(received).toEqual(["first", "250 ms", "500 ms"]);
  });

  it("an invalid message spends nothing", async () => {
    const { host, guest } = await lobby();
    const received: string[] = [];
    guest.on("chat-message", ({ message }: { message: string }) => received.push(message));
    host.emit("chat-message", { message: "   " });
    host.emit("chat-message", { message: "x".repeat(101) });
    const relayed = once(guest, "chat-message");
    host.emit("chat-message", { message: "hello" });
    await relayed;
    expect(received).toEqual(["hello"]);
  });

  it("is per socket: one player's message doesn't hold back another's", async () => {
    const { host, guest } = await lobby();
    host.emit("chat-message", { message: "from host" });
    const relayed = once<{ message: string }>(host, "chat-message");
    guest.emit("chat-message", { message: "from guest" });
    expect((await relayed).message).toBe("from guest");
  });

});

describe("per-socket limit state dies with the socket (EXP-159)", () => {
  it("join and chat limits are dropped on disconnect, even when the socket's room no longer exists", async () => {
    const { host, guest, gameCode } = await lobby();
    // The host spends its join attempts (1 create + 4 re-sends) and its chat message
    for (let i = 0; i < 4; i++) expect((await joinAs(host, gameCode, "host")).success).toBe(true);
    const relayed = once(guest, "chat-message");
    host.emit("chat-message", { message: "bye" });
    await relayed;
    // Socket ids are the same on both ends. A refused take() records nothing
    expect(joinAttempts.take(host.id!)).toBe(false);
    expect(chatMessages.take(host.id!)).toBe(false);

    const hostId = host.id!;
    roomManager.clear(); // the room is gone before the host's socket disconnects
    host.disconnect();
    // Date stays frozen, so neither the windows nor the sweep can free them: only the disconnect handler does
    await untilFrozen(() => joinAttempts.take(hostId));
    expect(chatMessages.take(hostId)).toBe(true);
  });
});

describe("submit-answer: burst 10 per socket, refilled 5/s", () => {
  it("records at most 10 at once, then one more every 200 ms", async () => {
    const { guest, gameCode } = await lobby();
    const record = vi.spyOn(GameEngine.prototype, "recordAnswer").mockImplementation(() => {});
    /** The join it already has: answered once every earlier event of the socket has been handled. */
    const barrier = async () => expect((await joinAs(guest, gameCode, "guest")).success).toBe(true);

    for (let i = 0; i < 30; i++) guest.emit("submit-answer", { guess: "host" });
    await barrier();
    expect(record).toHaveBeenCalledTimes(10);

    at(200);
    guest.emit("submit-answer", { guess: "host" });
    guest.emit("submit-answer", { guess: "host" });
    await barrier();
    expect(record).toHaveBeenCalledTimes(11);
  });
});
