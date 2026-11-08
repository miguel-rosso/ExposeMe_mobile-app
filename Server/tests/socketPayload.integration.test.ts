import { describe, expect, it } from "vitest";
import { io as connect, Socket as ClientSocket } from "socket.io-client";
import { isBinaryMessage, MAX_SOCKET_MESSAGE_BYTES } from "../middlewares/socketPayload";
import { useTestServer } from "./socketHarness";

// EXP-440: client messages are small JSON. One larger than MAX_SOCKET_MESSAGE_BYTES (over WebSocket or long-polling)
// or carrying binary data closes only that connection, before socket.io buffers it; everyone else plays on.

type ChatAck = { ok: true };

// Long enough for a local round trip; a missing ack resolves null after it
const ACK_WAIT_MS = 500;
const DISCONNECT_WAIT_MS = 2_000;

const harness = useTestServer({ resetBetweenTests: true });
const { once, silent, newClient, joinAs, clients } = harness;

/** chat-message with an ack callback: the server's answer, or null if none came in time. */
function chat(c: ClientSocket, payload: unknown): Promise<ChatAck | null> {
  return c.timeout(ACK_WAIT_MS).emitWithAck("chat-message", payload).catch(() => null);
}

/** A lobby with a host and a guest; `guestTransport` picks how the guest talks to the server. */
async function lobby(guestTransport: "websocket" | "polling" = "websocket") {
  const host = await newClient();
  const guest = connect(harness.url, { transports: [guestTransport], forceNew: true, reconnection: false });
  clients.push(guest);
  await once(guest, "connect");
  const { room } = await joinAs(host, null, "host");
  expect((await joinAs(guest, room!.gameCode, "guest")).success).toBe(true);
  return { host, guest };
}

/** A chat message whose encoded packet is larger than the limit (each "x" is one byte). */
const oversizedMessage = () => ({ message: "x".repeat(MAX_SOCKET_MESSAGE_BYTES) });

/** The host still talks to the room after the guest was cut off. */
async function expectHostStillChats(host: ClientSocket) {
  expect(host.connected).toBe(true);
  expect(await chat(host, { message: "still here" })).toEqual({ ok: true });
}

describe("socket message size limit", () => {
  it("delivers the largest legitimate payload (a 100-unit chat of emoji)", async () => {
    const { host, guest } = await lobby();
    const message = "😂".repeat(50); // 100 UTF-16 units, 200 bytes of UTF-8
    const relayed = once<{ message: string }>(host, "chat-message");
    expect(await chat(guest, { message })).toEqual({ ok: true });
    expect((await relayed).message).toBe(message);
  });

  it("closes a WebSocket connection that sends a message over the limit, and only that one", async () => {
    const { host, guest } = await lobby();
    const dropped = once(guest, "disconnect", DISCONNECT_WAIT_MS);
    const noRelay = silent(host, "chat-message");
    guest.emit("chat-message", oversizedMessage());
    await dropped;
    expect(await noRelay).toBe(true);
    await expectHostStillChats(host);
  });

  it("closes a long-polling connection that posts a body over the limit", async () => {
    const { host, guest } = await lobby("polling");
    const dropped = once(guest, "disconnect", DISCONNECT_WAIT_MS);
    const noRelay = silent(host, "chat-message");
    guest.emit("chat-message", oversizedMessage());
    await dropped;
    expect(await noRelay).toBe(true);
    await expectHostStillChats(host);
  });

  it("keeps a long-polling client below the limit with many queued small messages (split into several POSTs)", async () => {
    const { host, guest } = await lobby("polling");
    // ~60 KB queued at once: socket.io-client splits its batches by the maxPayload the server announced
    // (set-rounds from a guest is ignored, so the burst changes nothing in the room)
    const notes = Array.from({ length: 300 }, (_, i) => `${i} ${"y".repeat(190)}`);
    for (const note of notes) guest.emit("set-rounds", { rounds: 5, note });
    expect(await chat(guest, { message: "after the burst" })).toEqual({ ok: true });
    expect(guest.connected).toBe(true);
    await expectHostStillChats(host);
  });
});

describe("binary socket messages", () => {
  it("closes the connection of a binary event before it reaches a handler", async () => {
    const { host, guest } = await lobby();
    const dropped = once(guest, "disconnect", DISCONNECT_WAIT_MS);
    const noRelay = silent(host, "chat-message");
    guest.emit("chat-message", { message: "hi", attachment: Buffer.from("payload") });
    await dropped;
    expect(await noRelay).toBe(true);
    await expectHostStillChats(host);
  });

  it("closes a connection that announces attachments and holds back the last one", async () => {
    const { host, guest } = await lobby();
    const dropped = once(guest, "disconnect", DISCONNECT_WAIT_MS);
    // Raw socket.io packets: a BINARY_EVENT header for two attachments, then only the first. Without the guard
    // socket.io keeps the first buffer for as long as the client answers pings, waiting for the second.
    const placeholder = (num: number) => ({ _placeholder: true, num });
    guest.io.engine.send(`52-${JSON.stringify(["chat-message", placeholder(0), placeholder(1)])}`);
    guest.io.engine.send(Buffer.alloc(1024));
    await dropped;
    await expectHostStillChats(host);
  });

  it("tells binary messages from plain packets by their socket.io packet type", () => {
    expect(isBinaryMessage("0")).toBe(false); // CONNECT
    expect(isBinaryMessage('2["chat-message",{"message":"hi"}]')).toBe(false); // EVENT
    expect(isBinaryMessage("30[]")).toBe(false); // ACK
    expect(isBinaryMessage('51-["chat-message",{"_placeholder":true,"num":0}]')).toBe(true); // BINARY_EVENT
    expect(isBinaryMessage('61-0[{"_placeholder":true,"num":0}]')).toBe(true); // BINARY_ACK
    expect(isBinaryMessage(Buffer.from("2[]"))).toBe(true); // an attachment
  });
});
