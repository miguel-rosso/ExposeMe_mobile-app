import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { uploadPath } from "../middlewares/upload";

const FILE_TTL = 30 * 60 * 1000; // 30 minutes — games can last 15+ min

export const UploadRouter = async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const imageUrl = `/temp/${req.file.filename}`;

  // Schedule file deletion
  setTimeout(() => {
    fs.unlink(path.join(uploadPath, req.file!.filename), (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("Error deleting file:", err);
      }
    });
  }, FILE_TTL);

  res.json({ url: imageUrl });
};
