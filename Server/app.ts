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

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 90_000,    // Wait 90s before considering client dead
  pingInterval: 25_000,   // Ping every 25s
});

export { server, io };
