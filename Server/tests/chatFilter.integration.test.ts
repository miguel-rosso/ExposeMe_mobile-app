import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { useTestServer } from "./socketHarness";

// EXP-424: chat-message is relayed to the room with offensive words masked (see managers/chatFilter); the rest of the
// message, and the sender's username, go through untouched. The sender's ack carries the same masked text (no shadow
// filtering: the app shows it as the sender's own bubble); a dropped message is not acked.

type ChatAck = { message: string };

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

describe("chat-message moderation", () => {
  it("relays the message with offensive words masked, and acks the sender the same text", async () => {
    const { host, guest } = await lobby();
    const relayed = once<{ username: string; message: string }>(guest, "chat-message");
    const ack = chat(host, { message: "qué p.u.t.a foto, la computadora de mierda 😂" });
    const masked = "qué p****** foto, la computadora de m***** 😂";
    expect(await relayed).toEqual({ username: "host", message: masked });
    expect(await ack).toEqual({ message: masked });
  });

  it("acks a clean message unchanged", async () => {
    const { host } = await lobby();
    expect(await chat(host, { message: "hola, ¿de quién es?" })).toEqual({ message: "hola, ¿de quién es?" });
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
      expect(await chat(host, { message: "first" })).toEqual({ message: "first" });
      expect(await chat(host, { message: "too soon" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
