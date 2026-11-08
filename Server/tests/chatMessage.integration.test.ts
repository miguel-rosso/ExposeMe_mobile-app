import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { useTestServer } from "./socketHarness";

// EXP-438 (DEC-060 A): chat-message is relayed to the room exactly as typed, with the sender's session username; there
// is no word filter (moderation is per viewer: each player mutes or reports). The sender's ack only says the room got
// it ({ ok: true }: the app then shows its own bubble); a dropped message is not acked.

type ChatAck = { ok: true };

// Long enough for a local round trip; a missing ack resolves null after it
const ACK_WAIT_MS = 500;

const { once, newClient, joinAs } = useTestServer({ resetBetweenTests: true });

/** chat-message with an ack callback: the server's answer, or null if none came in time. */
function chat(c: ClientSocket, payload: unknown): Promise<ChatAck | null> {
  return c.timeout(ACK_WAIT_MS).emitWithAck("chat-message", payload).catch(() => null);
}

/** A lobby with a host and a guest, each on its own socket. */
async function lobby() {
  const host = await newClient();
  const guest = await newClient();
  const { room } = await joinAs(host, null, "host");
  expect((await joinAs(guest, room!.gameCode, "guest")).success).toBe(true);
  return { host, guest };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat-message", () => {
  it("relays the message exactly as typed, words once masked included, and acks the sender { ok: true }", async () => {
    const { host, guest } = await lobby();
    const message = "qué p.u.t.a foto, la computadora de mierda 😂";
    const relayed = once<{ username: string; message: string }>(guest, "chat-message");
    const ack = chat(host, { message });
    expect(await relayed).toEqual({ username: "host", message });
    expect(await ack).toEqual({ ok: true });
  });

  it("does not ack a message it drops: blank, too long, from a socket in no room, or over the rate limit", async () => {
    const { host } = await lobby();
    expect(await chat(host, { message: "   " })).toBeNull();
    expect(await chat(host, { message: "x".repeat(101) })).toBeNull();
    expect(await chat(host, {})).toBeNull();
    expect(await chat(await newClient(), { message: "hola" })).toBeNull();

    // Date frozen: the next message is surely within the 250 ms of the one before, however slow the machine
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await chat(host, { message: "first" })).toEqual({ ok: true });
      expect(await chat(host, { message: "too soon" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
