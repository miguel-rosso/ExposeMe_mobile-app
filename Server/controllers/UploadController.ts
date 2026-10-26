import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { uploadPath } from "../middlewares/upload";
import { ImageRejected, sanitizeImage } from "./sanitizeImage";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { Member, stillMember } from "../middlewares/uploadAccess";
import { UploadRecord, uploadStore } from "../middlewares/uploadStore";

const refuseStale = (res: Response) => res.status(409).json({ error: "Upload no longer accepted" });

export const UploadRouter = async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // The client may go away (abort, upload timeout) while its image waits for processing: its in-flight slot is freed
  // then, so its job must leave the sanitize queue too (keeps queued buffers within the in-flight memory bound)
  const gone = new AbortController();
  const onClose = () => { if (!res.writableFinished) gone.abort(); };
  res.once("close", onClose);
  // Already gone before we got here (e.g. while multer read the body): "close" won't fire again, don't queue the job
  if (req.socket.destroyed) gone.abort();
  let image: Awaited<ReturnType<typeof sanitizeImage>>;
  try {
    image = await sanitizeImage(req.file.buffer, gone.signal);
  } catch (err) {
    if (err instanceof ImageRejected) {
      if (res.headersSent || gone.signal.aborted) return;
      if (err.retryAfterS) res.setHeader("Retry-After", String(err.retryAfterS));
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  // Bound to the uploader's room (requireRoomMember / requireUploadAllowed ran before). The game may have ended, the
  // room closed or the player left while the image was processed: then nothing is stored.
  // Already answered or the client is gone (upload timeout / abort, see middlewares/uploadInFlight): store nothing
  if (res.headersSent || req.socket.destroyed) return;
  const member = res.locals.member as Member;
  if (!stillMember(member)) return refuseStale(res);

  // Unguessable name; nothing from the client (originalname, MIME) ends up in the URL
  const filename = `${crypto.randomBytes(16).toString("hex")}.${image.ext}`;
  const filePath = path.join(uploadPath, filename);
  const record: UploadRecord = {
    gameCode: member.room.gameCode,
    username: member.player.username,
    file: filePath,
    round: member.room.round,
    kind: res.locals.uploadKind,
  };
  if (!uploadStore.register(filename, record, res.locals.uploadEpoch)) return refuseStale(res);
  try {
    await fs.promises.writeFile(filePath, image.data, { flag: "wx" });
  } catch (err) {
    uploadStore.forget(filename);
    throw err;
  }
  // Released (game over / room closed) during the write: its deletion may have run before the file existed
  if (uploadStore.get(filename) !== record) {
    await fs.promises.unlink(filePath).catch(() => {});
    return refuseStale(res);
  }

  // Exact-time deletion (cleared by the store if the photo goes earlier: game over, room closed, player left);
  // the periodic sweep (middlewares/uploadSweeper) covers restarts
  record.timer = setTimeout(() => {
    uploadStore.forget(filename);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("Error deleting file:", err);
      }
    });
  }, UPLOAD_TTL_MS);
  record.timer.unref();

  // Supersedes this player's older unused uploads of the same round (lobby re-pick, own-turn retry)
  uploadStore.releaseSuperseded(filename, member.room.currentPhoto);

  res.json({ url: `/temp/${filename}` });
};
