import express from "express";
import { UploadRouter } from "../controllers/UploadController";
import { singleImage } from "../middlewares/upload";
import { uploadRateLimit } from "../middlewares/rateLimit";
import { requireRoomMember, requireUploadAllowed } from "../middlewares/uploadAccess";

const router = express.Router();

// ── Invite page helpers ──
const ROOM_CODE_RE = /^\d{6}$/;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// JSON string literal safe to embed inside an inline <script>
const toScriptString = (value: string) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// Room members only (session credential in headers), and only when the room accepts a photo from them
router.post("/upload", uploadRateLimit, requireRoomMember, requireUploadAllowed, singleImage("image"), (req, res, next) => {
  UploadRouter(req, res).catch(next);
});

router.get("/", (_req, res) => {
  res.send("SERVER RUNNING");
});

router.get("/join/:code", (req, res) => {
  const code = req.params.code;
  if (!ROOM_CODE_RE.test(code)) {
    res.status(400).type("text/plain").send("Invalid game code");
    return;
  }
  const scheme = "myapp";
  const deepLink = `${scheme}://screens/WaitingRoom?code=${encodeURIComponent(code)}`;

  // Mobile browsers will try the deep link; fallback shows the code
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Join ExposeMe Game</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #111; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .card { text-align: center; padding: 2rem; }
        .code { font-size: 3rem; font-weight: 900; letter-spacing: 6px; margin: 1rem 0; }
        .btn { display: inline-block; background: #e9042e; color: #fff; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-weight: 700; font-size: 1.1rem; margin-top: 1rem; }
        .sub { opacity: 0.6; font-size: 0.9rem; margin-top: 1.5rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>ExposeMe</h1>
        <p>You've been invited to a game!</p>
        <div class="code">${escapeHtml(code)}</div>
        <a class="btn" href="${escapeHtml(deepLink)}">Open in App</a>
        <p class="sub">If the app doesn't open, enter the code manually.</p>
      </div>
      <script>window.location.href = ${toScriptString(deepLink)};</script>
    </body>
    </html>
  `);
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    timestamp: new Date().toISOString(),
  });
});

export default router;
