import crypto from "crypto";
import express from "express";
import { UploadRouter } from "../controllers/UploadController";
import { singleImage } from "../middlewares/upload";
import { uploadPlayerRateLimit, uploadRoomRateLimit } from "../middlewares/rateLimit";
import { uploadDeclaredSize, uploadInFlightLimit } from "../middlewares/uploadInFlight";
import { requireUploadAllowed, requireUploadMember } from "../middlewares/uploadAccess";
import { joinPageCsp } from "../middlewares/securityHeaders";
import { isRoomCode, normalizeRoomCode } from "../managers/roomCode";
import { APP_STORE_ID, INVITE_LANGUAGES, pickInviteLanguage, platformOf, renderJoinPage } from "./joinPage";
import { servePrivacyPage } from "./privacyPage";

const router = express.Router();

// Room members only (session credential in headers), and only when the room accepts a photo from them.
// Nothing reads the body before multer: a declared oversize body is refused first (413, no slot taken); then the
// credentials (rejected requests rate limited per IP); then only members take an in-flight slot (concurrency caps per
// member, room, IP and server-wide, plus the upload timeout; see middlewares/uploadInFlight); then the per-member and
// per-room rate limits (see middlewares/rateLimit).
const uploadLimits = [uploadDeclaredSize, requireUploadMember, uploadInFlightLimit, uploadPlayerRateLimit, uploadRoomRateLimit];
router.post("/upload", ...uploadLimits, requireUploadAllowed, singleImage("image"), (req, res, next) => {
  UploadRouter(req, res).catch(next);
});

router.get("/", (_req, res) => {
  res.send("SERVER RUNNING");
});

// Invite page (see routes/joinPage): in the visitor's language, with the store links for their device
router.get("/join/:code", (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (!isRoomCode(code)) {
    res.status(400).type("text/plain").send("Invalid game code");
    return;
  }
  // The page depends on these headers: a cache must not serve one visitor's page to another
  res.vary("Accept-Language").vary("User-Agent");

  // The global deny-all CSP would block the page's inline style/script: allow them, the script by nonce only
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader("Content-Security-Policy", joinPageCsp(nonce));
  res.send(
    renderJoinPage({
      code,
      language: pickInviteLanguage(req.acceptsLanguages(...INVITE_LANGUAGES)),
      platform: platformOf(req.get("user-agent")),
      appStoreId: APP_STORE_ID,
      nonce,
    }),
  );
});

// Privacy policy (see routes/privacyPage), linked from the stores and the app
router.get("/privacy", servePrivacyPage);

// Liveness only: no uptime, memory or other process details for anonymous callers
router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

export default router;
