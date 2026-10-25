import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";
import uploadRoutes from "./routes/uploadRoutes";
import { uploadPath } from "./middlewares/upload";
import { parseTrustProxy } from "./middlewares/rateLimit";

const app = express();

// Behind a reverse proxy (Render) req.ip must come from X-Forwarded-For, or every client would share the
// proxy's IP for the /upload rate limit (see parseTrustProxy).
const trustProxyHops = parseTrustProxy(process.env.TRUST_PROXY, Boolean(process.env.RENDER));
if (trustProxyHops > 0) app.set("trust proxy", trustProxyHops);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/temp", express.static(uploadPath));
app.use("/", uploadRoutes);

// ── Socket heartbeat ──
// The server pings every PING_INTERVAL and drops a client that doesn't answer within PING_TIMEOUT, so a
// phone that silently lost network is marked disconnected (and no longer picked as photo owner) after at
// most PING_INTERVAL + PING_TIMEOUT. A dropped player stays in the room and can rejoin with its
// rejoinToken (WaitingRoom and the in-game useGameConnection hook both re-join on reconnect).
// 15s of pong tolerance absorbs slow mobile radios/handovers.
// Env-overridable, clamped to a sane range (sub-second values only under NODE_ENV=test).
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 300_000;

export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = Number(raw);
  if (!raw || !Number.isFinite(v) || v <= 0) return fallback;
  const min = process.env.NODE_ENV === "test" ? 1 : HEARTBEAT_MIN_MS;
  return Math.min(Math.max(Math.round(v), min), HEARTBEAT_MAX_MS);
}
export const PING_INTERVAL = envMs("SOCKET_PING_INTERVAL_MS", 10_000);
export const PING_TIMEOUT = envMs("SOCKET_PING_TIMEOUT_MS", 15_000);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingInterval: PING_INTERVAL,
  pingTimeout: PING_TIMEOUT,
});

export { server, io };
