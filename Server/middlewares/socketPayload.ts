// ── Socket message size and binary packets ──
// Every client event is a small JSON payload: the largest one is a chat message (≤100 UTF-16 units, at most ~400
// bytes in UTF-8) or a join (a 15-unit name, room code and rejoin token, ~150 bytes); photos go through HTTP /upload.
// MAX_SOCKET_MESSAGE_BYTES bounds what engine.io reads per message (a WebSocket frame, or the body of one
// long-polling POST): the server refuses a larger one before buffering or parsing it (WebSocket: closes with 1009;
// polling: 413, and the client then drops the connection). engine.io sends the bound to clients in its handshake
// (`maxPayload`), so socket.io-client splits its polling batches below it.
// Only incoming messages are limited; what the server sends (room lists, photo URLs) is not.
export const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024;

// No event carries binary data either. socket.io keeps the attachments of a binary event in memory until the last
// one arrives (socket.io-parser allows 10 per event, so at most 10 × MAX_SOCKET_MESSAGE_BYTES with the size cap);
// closing on the first binary message is defence in depth, so nothing is held at all. The socket.io packet type is
// the first character of a message: 5 (BINARY_EVENT) and 6 (BINARY_ACK) announce attachments, and the attachments
// themselves arrive as binary messages.
const BINARY_PACKET_TYPES = new Set(["5", "6"]);

/** True for a message that is, or announces, binary data (no client event sends any). */
export function isBinaryMessage(data: unknown): boolean {
  return typeof data !== "string" || BINARY_PACKET_TYPES.has(data[0]);
}

/** The part of an engine.io connection the binary guard uses. */
interface EngineConnection {
  on(event: "data", listener: (data: unknown) => void): unknown;
  close(): unknown;
}

/**
 * For `io.engine.on("connection")`: closes the connection on its first binary message. socket.io's decoder (which
 * sees the message first) drops a pending binary event when its connection closes, so nothing stays buffered.
 */
export function closeOnBinaryMessage(conn: EngineConnection): void {
  conn.on("data", (data) => {
    if (isBinaryMessage(data)) conn.close();
  });
}
