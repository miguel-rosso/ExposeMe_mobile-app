import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { uploadPath } from "../middlewares/upload";
import { ImageRejected, sanitizeImage } from "./sanitizeImage";

const FILE_TTL = 30 * 60 * 1000; // 30 minutes — games can last 15+ min

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

  // Unguessable name; nothing from the client (originalname, MIME) ends up in the URL
  const filename = `${crypto.randomBytes(16).toString("hex")}.${image.ext}`;
  const filePath = path.join(uploadPath, filename);
  await fs.promises.writeFile(filePath, image.data, { flag: "wx" });

  // Schedule file deletion
  setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("Error deleting file:", err);
      }
    });
  }, FILE_TTL).unref();

  res.json({ url: `/temp/${filename}` });
};
