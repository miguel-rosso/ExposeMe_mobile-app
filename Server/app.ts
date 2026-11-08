import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";
import uploadRoutes from "./routes/uploadRoutes";
import { uploadPath } from "./middlewares/upload";
import { parseTrustProxy } from "./middlewares/rateLimit";
import { serveUpload, startUploadSweeper } from "./middlewares/uploadSweeper";
import { errorHandler } from "./middlewares/errorHandler";
import { notFound, securityHeaders } from "./middlewares/securityHeaders";
import { requireRoomMember, requireRoomUpload } from "./middlewares/uploadAccess";
import { socketHandshakeLimit, socketOriginGuard } from "./middlewares/socketOrigin";
import { reportStore } from "./managers/reportStore";
import { closeOnBinaryMessage, MAX_SOCKET_MESSAGE_BYTES } from "./middlewares/socketPayload";
import { closeUnreadBodyAfterResponse } from "./middlewares/unreadBody";

const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy (Render) req.ip must come from X-Forwarded-For, or every client would share the
// proxy's IP for the /upload rate limit (see parseTrustProxy).
const trustProxyHops = parseTrustProxy(process.env.TRUST_PROXY, Boolean(process.env.RENDER));
if (trustProxyHops > 0) app.set("trust proxy", trustProxyHops);

app.use(securityHeaders);
// No CORS: the only clients are the native app and Node bots, which don't enforce it, and the /join invite page is a
// top-level navigation. Without Access-Control-* headers no other website can read these responses from a browser.
// No JSON/urlencoded body parsers either: no route reads such a body (POST /upload is multipart, parsed by multer after
// its limits), and body-parser reads a body it refuses to its very end before answering.

// Uploads: exact /temp/<32 hex>.<ext> route only (no static directory listing of other files), and only to members
// of the room the photo was uploaded in (session credential in headers, see middlewares/uploadAccess)
app.get("/temp/:name", requireRoomMember, requireRoomUpload, serveUpload(uploadPath));
app.use("/temp", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use("/", uploadRoutes);
// Unknown routes: JSON 404 that never echoes the path
app.use(notFound);
// Last: JSON errors without stack traces or server paths (bad URL encoding, disk failures)
app.use(errorHandler);

// ── Socket heartbeat ──
// The server pings every PING_INTERVAL and drops a client that doesn't answer within PING_TIMEOUT, so a
// phone that silently lost network is marked disconnected (and no longer picked as photo owner) after at
// most PING_INTERVAL + PING_TIMEOUT. A dropped player stays in the room and can rejoin with its
// rejoinToken (WaitingRoom and the in-game useGameConnection hook both re-join on reconnect).
// 15s of pong tolerance absorbs slow mobile radios/handovers.
// Env-overridable, clamped to a sane range (sub-second values only under NODE_ENV=test).
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 300_000;

/** Duration env var in ms, rounded and clamped; `fallback` when unset, or when not a positive number (logged). */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    console.warn(`[config] ignoring ${name}=${raw} (not a positive number of ms)`);
    return fallback;
  }
  const min = process.env.NODE_ENV === "test" ? 1 : HEARTBEAT_MIN_MS;
  return Math.min(Math.max(Math.round(v), min), HEARTBEAT_MAX_MS);
}
export const PING_INTERVAL = envMs("SOCKET_PING_INTERVAL_MS", 10_000);
export const PING_TIMEOUT = envMs("SOCKET_PING_TIMEOUT_MS", 15_000);

// ── HTTP timeouts ──
// Slow requests can't hold a connection for long: the whole request, body included, must arrive within
// HTTP_REQUEST_TIMEOUT_MS and its headers within HTTP_HEADERS_TIMEOUT_MS; Node checks both every 5 s. POST /upload
// has its own, shorter limit (UPLOAD_REQUEST_TIMEOUT_MS, middlewares/uploadInFlight). WebSocket upgrades are not
// affected, and long-polling only has to send its (tiny) request within the limit.
export const HTTP_REQUEST_TIMEOUT_MS = envMs("HTTP_REQUEST_TIMEOUT_MS", 60_000);
export const HTTP_HEADERS_TIMEOUT_MS = Math.min(envMs("HTTP_HEADERS_TIMEOUT_MS", 20_000), HTTP_REQUEST_TIMEOUT_MS);

const server = createServer({ connectionsCheckingInterval: Math.min(5_000, HTTP_HEADERS_TIMEOUT_MS) }, app);
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
// No `cors` option either (see app.use above): other websites can't read long-polling responses from a browser.
// CORS doesn't cover WebSockets or JSONP, so every socket.io request (handshake, polling of an open session, upgrade)
// is also checked: another website's Origin, a Host outside ALLOWED_HOSTS (when set) and JSONP polling are refused,
// then new sessions are rate limited per IP (see socketOrigin). Client messages are small JSON only: a larger or a
// binary one closes its connection (see socketPayload).
const io = new Server(server, {
  pingInterval: PING_INTERVAL,
  pingTimeout: PING_TIMEOUT,
  maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
});
io.engine.use(socketOriginGuard);
io.engine.use(socketHandshakeLimit);
io.engine.on("connection", closeOnBinaryMessage);
// Every request, Express' and socket.io's alike (see middlewares/unreadBody). Must stay AFTER `new Server(server, …)`:
// socket.io's attach() takes the 'request' listeners registered so far and only calls them for paths outside
// /socket.io/, so registered before it this would never see socket.io's own requests.
server.prependListener("request", closeUnreadBodyAfterResponse);

// Deletes uploads past their TTL at startup (leftovers from a previous process) and periodically after that
const uploadSweeper = startUploadSweeper(uploadPath);
server.on("close", uploadSweeper.stop);
// Deletes content reports (and their photo copies) past REPORT_RETENTION_DAYS, at startup and daily
const reportPurge = reportStore.startPurging();
server.on("close", reportPurge.stop);

export { server, io };
