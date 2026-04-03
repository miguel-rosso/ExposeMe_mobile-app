import express from "express";
import { UploadRouter } from "../controllers/UploadController";
import { upload } from "../middlewares/upload";

const router = express.Router();

router.post("/upload", upload.single("image"), (req, res, next) => {
  UploadRouter(req, res).catch(next);
});

router.get("/", (_req, res) => {
  res.send("SERVER RUNNING");
});

router.get("/join/:code", (req, res) => {
  const code = req.params.code;
  const scheme = "myapp";
  const deepLink = `${scheme}://screens/WaitingRoom?code=${code}`;

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
        <div class="code">${code}</div>
        <a class="btn" href="${deepLink}">Open in App</a>
        <p class="sub">If the app doesn't open, enter the code manually.</p>
      </div>
      <script>window.location.href = "${deepLink}";</script>
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
