import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import { useTestServer } from "./socketHarness";

// EXP-438 (DEC-060 A): chat-message is relayed to the room as typed, with the sender's session username; there is no
// word filter (moderation is per viewer: each player mutes or reports). EXP-447: only characters that break the bubble
// or hide or reorder the text are normalised (managers/chatText.ts), and the sender's ack carries the text the room
// got ({ ok: true, message }: the app then shows its own bubble with it); a dropped message is not acked.

type ChatAck = { ok: true; message: string };

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
  it("relays the message exactly as typed, words once masked included, and acks the sender with it", async () => {
    const { host, guest } = await lobby();
    const message = "qué p.u.t.a foto, la computadora de mierda 😂";
    const relayed = once<{ username: string; message: string }>(guest, "chat-message");
    const ack = chat(host, { message });
    expect(await relayed).toEqual({ username: "host", message });
    expect(await ack).toEqual({ ok: true, message });
  });

  // EXP-447: the room and the sender see the same text, without bidi overrides, invisible characters or a wall of lines
  it("relays and acks the normalised text: no bidi overrides or zero-width characters, at most 3 line breaks", async () => {
    const { host, guest } = await lobby();
    const relayed = once<{ username: string; message: string }>(guest, "chat-message");
    const ack = chat(host, { message: "\u202Eh\u200Bola\u202C" + "\n".repeat(80) + "1\n2\n3\n4" });
    expect(await relayed).toEqual({ username: "host", message: "hola\n1\n2\n3 4" });
    expect(await ack).toEqual({ ok: true, message: "hola\n1\n2\n3 4" });
  });

  it("does not ack a message it drops: blank or invisible, too long, from a socket in no room, or over the rate limit", async () => {
    const { host } = await lobby();
    expect(await chat(host, { message: "   " })).toBeNull();
    expect(await chat(host, { message: "\u200B\u3164\u202E\n\n" })).toBeNull();
    expect(await chat(host, { message: "x".repeat(101) })).toBeNull();
    expect(await chat(host, {})).toBeNull();
    expect(await chat(await newClient(), { message: "hola" })).toBeNull();

    // Date frozen: the next message is surely within the 250 ms of the one before, however slow the machine
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await chat(host, { message: "first" })).toEqual({ ok: true, message: "first" });
      expect(await chat(host, { message: "too soon" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
