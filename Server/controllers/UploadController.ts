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

  let image: Awaited<ReturnType<typeof sanitizeImage>>;
  try {
    image = await sanitizeImage(req.file.buffer);
  } catch (err) {
    if (err instanceof ImageRejected) {
      if (err.retryAfterS) res.setHeader("Retry-After", String(err.retryAfterS));
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  // Bound to the uploader's room (requireRoomMember / requireUploadAllowed ran before). The game may have ended, the
  // room closed or the player left while the image was processed: then nothing is stored.
  const member = res.locals.member as Member;
  if (!stillMember(member)) return refuseStale(res);

  // Unguessable name; nothing from the client (originalname, MIME) ends up in the URL
  const filename = `${crypto.randomBytes(16).toString("hex")}.${image.ext}`;
  const filePath = path.join(uploadPath, filename);
  const record: UploadRecord = { gameCode: member.room.gameCode, username: member.player.username, file: filePath };
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

  res.json({ url: `/temp/${filename}` });
};
